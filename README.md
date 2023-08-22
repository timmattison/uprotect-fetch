# ubiquiti-video-library

You can use this library to fetch video from your Ubiquiti Protect DVR.

You'll need to know your UniFi Protect appliance's IP address, your login credentials, the ID of the camera(s) you want
to fetch video for, and ffmpeg installed to convert the video to `.mkv` format.

Video is converted to `.mkv` automatically since the default `.mp4` files that Ubiquiti Protect are incompatible with
some non-linear editors ilke Davinci Resolve.

## Simple usage

```typescript
  const cameras = [{ id: args.cameraName, name: args.cameraName }]
  const auth = {
    username: 'username',
    password: 'password'
  }

  const result = await fetchVideo({
    ipAddress: UbiquitiEnvironment.UbiquitiIp,
    auth,
    cameras,
    start: // Some start date
    end: // Some end date
    mp4: // True if you want MP4 files
  })
  
  console.log(result)
```

## Advanced usage with status bar

```typescript
  const cameras = [{ id: args.cameraName, name: args.cameraName }]
  const auth = {
    username: UbiquitiEnvironment.UbiquitiUsername,
    password: UbiquitiEnvironment.UbiquitiPassword,
  }

  const spinner = ora().start()

  const result = await fetchVideo({
    ipAddress: UbiquitiEnvironment.UbiquitiIp,
    auth,
    cameras,
    start: // Some start date
    end: // Some end date
    mp4: // True if you want MP4 files
    statusCallback: (status: Status) => {
      switch (status.type) {
        case StatusType.Waiting:
          spinner.text = 'Waiting to start downloading...'
          break
        case StatusType.Downloading:
          if (status.progressPercent !== undefined) {
            spinner.text = `Downloading: ${String(status.progressPercent)}`
          } else {
            spinner.text = 'Downloading...'
          }
          break
        case StatusType.DownloadThroughput:
          if (status.throughputString !== undefined) {
            spinner.text = `Download throughput: ${String(
              status.throughputString,
            )}/s`
          }
          break
        case StatusType.Converting:
          spinner.text = `Converting...`
          break
        case StatusType.Error:
          throw status.error
      }
    },
  })
```
