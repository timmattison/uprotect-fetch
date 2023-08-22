import { URLSearchParams } from 'url'
import axios, { type AxiosResponse } from 'axios'
import axiosRetry from 'axios-retry'
import * as https from 'https'
import * as fs from 'fs'
import ffmpeg from 'fluent-ffmpeg'
import {
  add,
  differenceInMinutes,
  differenceInSeconds,
  format,
  isBefore,
} from 'date-fns'

export enum StatusType {
  Waiting,
  Downloading,
  DownloadThroughput,
  Converting,
  Error,
}

export interface WaitingStatus {
  type: StatusType.Waiting
}

export interface DownloadingStatus {
  type: StatusType.Downloading
  progressPercent?: string
}

export interface ConvertingStatus {
  type: StatusType.Converting
}

export interface ErrorStatus {
  type: StatusType.Error
  error: Error
  errorString: string
}

export interface DownloadThroughput {
  type: StatusType.DownloadThroughput
  throughputString: string
}

export type Status =
  | WaitingStatus
  | DownloadingStatus
  | DownloadThroughput
  | ConvertingStatus
  | ErrorStatus

type Payload = Record<string, any>
type Cookies = Record<string, string>

async function postWithCookies(
  url: string,
  payload: Payload,
  cookies: Cookies = {},
): Promise<{
  responseText: string
  updatedCookies: Cookies
}> {
  const headers = {
    'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
    Cookie: Object.entries(cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; '),
  }

  const body = new URLSearchParams(payload).toString()

  // Configure retries
  axiosRetry(axios, {
    retries: 3,
    // Retry on Network Errors & 4xx responses
    retryCondition: (error) => {
      return error.response == null || error.response.status >= 400
    },
  })

  const response: AxiosResponse = await axios.post(url, body, {
    headers,
    httpsAgent: new https.Agent({
      rejectUnauthorized: false,
    }),
    withCredentials: true,
  })

  const responseText = response.data

  const setCookieHeader = response.headers['set-cookie']
  const updatedCookies = { ...cookies }

  if (setCookieHeader !== undefined) {
    setCookieHeader.forEach((cookie: string) => {
      safeUpdateCookie(cookie, updatedCookies)
    })
  }

  return { responseText, updatedCookies }
}

function safeUpdateCookie(cookie: string, updatedCookies: Cookies) {
  const splitCookie = cookie.split(';')

  if (splitCookie.length !== 1) return
  if (splitCookie[0] === undefined) return

  const [key, value] = splitCookie[0].split('=')

  if (key === undefined || value === undefined) return

  updatedCookies[key.trim()] = value.trim()
}

function percent(input: number | undefined) {
  if (input === undefined) return 'Unknown'

  return input.toLocaleString(undefined, {
    style: 'percent',
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })
}

async function getBinaryDataWithCookies(args: {
  url: string
  cookies?: Cookies
  filename: string
  statusCallback?: (status: Status) => void
}): Promise<{
  updatedCookies: Cookies
}> {
  if (args.cookies === undefined) args.cookies = {}

  const headers = {
    Cookie: Object.entries(args.cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; '),
  }

  const writer = fs.createWriteStream(args.filename)

  args.statusCallback?.({ type: StatusType.Waiting })

  const response: AxiosResponse = await axios.get(args.url, {
    headers,
    httpsAgent: new https.Agent({
      rejectUnauthorized: false,
    }),
    withCredentials: true,
    responseType: 'stream',
    onDownloadProgress: (progressEvent) =>
      args.statusCallback?.({
        type: StatusType.Downloading,
        progressPercent: percent(progressEvent.progress),
      }),
  })

  response.data.pipe(writer)

  const setCookieHeader = response.headers['set-cookie']
  const updatedCookies = { ...args.cookies }

  if (setCookieHeader != null) {
    setCookieHeader.forEach((cookie: string) => {
      safeUpdateCookie(cookie, updatedCookies)
    })
  }

  return await new Promise<{ updatedCookies: Cookies }>((resolve, reject) => {
    writer.on('finish', () => {
      args.statusCallback?.({
        type: StatusType.Downloading,
        progressPercent: '100%',
      })
      resolve({ updatedCookies })
    })
    writer.on('error', (err) => {
      args.statusCallback?.({
        type: StatusType.Error,
        error: err,
        errorString: `Error writing to the file ${args.filename}`,
      })
      reject(err)
    })
    response.data.on('error', (err: Error) => {
      args.statusCallback?.({
        type: StatusType.Error,
        error: err,
        errorString: `Error reading the response from the server`,
      })
      reject(err)
    })
  })
}

interface AuthPayload {
  username: string
  password: string
}

async function getCookies(authPayload: AuthPayload, ipAddress: string) {
  const cookies: Cookies = {}

  // const { responseText: loginResult, updatedCookies: loginCookies } =
  const { updatedCookies: loginCookies } = await postWithCookies(
    `https://${ipAddress}:443/api/auth/login`,
    authPayload,
    cookies,
  )

  return loginCookies
}

interface OutputFileType {
  cameraName: string
  start: Date
  end: Date
  filename: string
}

async function convertToMkv(inputPath: string, outputPath: string) {
  return await new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions('-c', 'copy') // This copies the existing audio and video streams without re-encoding
      .output(outputPath)
      .on('start', function () {
        // console.log('Conversion started')
      })
      .on('progress', function (progress) {
        // console.log(`Progress: ${progress.percent}% done`)
      })
      .on('end', function () {
        // console.log('Conversion ended successfully')
        resolve(true)
      })
      .on('error', function (err) {
        console.log('Conversion error: ', err)
        reject(err)
      })
      .run()
  })
}

function formatDate(date: Date) {
  return format(date, 'yyyy-MM-dd hh:mm:ss aa')
}

export async function fetchVideo(args: {
  ipAddress: string
  cameras: Array<{ id: string; name?: string }>
  start: Date
  end: Date
  mp4?: boolean
  statusCallback?: (status: Status) => void
  auth: AuthPayload
}) {
  if (args.mp4 === undefined) args.mp4 = true

  const outputFiles: OutputFileType[] = []

  let currentStart = args.start

  const maxMinuteDiff = {
    minutes: 60,
  }

  while (isBefore(currentStart, args.end)) {
    const diffInMinutes = differenceInMinutes(args.end, currentStart)
    let currentEnd: Date

    if (diffInMinutes > maxMinuteDiff.minutes) {
      currentEnd = add(currentStart, maxMinuteDiff)
    } else {
      currentEnd = args.end
    }

    for (const camera of args.cameras) {
      const url = `https://${
        args.ipAddress
      }:443/proxy/protect/api/video/export?camera=${
        camera.id
      }&start=${currentStart.getTime()}&end=${currentEnd.getTime()}`

      const formattedStart = formatDate(currentStart)
      const formattedEnd = formatDate(currentEnd)

      const baseFilename = `${formattedStart}_${formattedEnd}_${
        camera.name ?? camera.id
      }`
      const mp4Filename = `${baseFilename}.mp4`
      const mkvFilename = `${baseFilename}.mkv`

      currentStart = add(currentStart, maxMinuteDiff)

      if (fs.existsSync(mp4Filename)) {
        if (fs.statSync(mp4Filename).size === 0) {
          fs.unlinkSync(mp4Filename)
        } else {
          console.log(
            `${mp4Filename} already exists and is not empty, refusing to overwrite it`,
          )
          continue
        }
      }

      const downloadStart = Date.now()

      // Get cookies each time so we don't time out our login on requests for large videos
      const cookies = await getCookies(args.auth, args.ipAddress)

      await getBinaryDataWithCookies({
        url,
        cookies,
        filename: mp4Filename,
        statusCallback: args.statusCallback,
      })

      const downloadEnd = Date.now()
      const diffInSeconds = differenceInSeconds(downloadEnd, downloadStart)
      const mp4FileStats = fs.statSync(mp4Filename)
      const throughput = mp4FileStats.size / diffInSeconds

      let throughputString: string

      if (throughput > 1000000) {
        throughputString = `${Math.round(throughput / 1000000)} MB`
      } else {
        throughputString = `${Math.round(throughput)} B`
      }

      // Must log something here or the user will only see the live download
      //   updates but won't know how many files were downloaded already
      args.statusCallback?.({
        type: StatusType.DownloadThroughput,
        throughputString,
      })

      if (!args.mp4) {
        args.statusCallback?.({
          type: StatusType.Converting,
        })

        await convertToMkv(mp4Filename, mkvFilename)
        fs.unlinkSync(mp4Filename)
      }

      outputFiles.push({
        cameraName: camera.name ?? camera.id,
        start: args.start,
        end: args.end,
        filename: args.mp4 ? mp4Filename : mkvFilename,
      })
    }
  }

  return outputFiles
}
