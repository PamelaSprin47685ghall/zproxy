namespace ZProxy

open System
open System.Net

module Options =
    type Limits =
        { UploadWindowLog: int
          DownloadWindowLog: int
          MaxStreams: int
          StreamWindowBytes: int }

    let defaults =
        { UploadWindowLog = 23
          DownloadWindowLog = 20
          MaxStreams = 16
          StreamWindowBytes = 256 * 1024 }

    let validate limits =
        if limits.UploadWindowLog < 10 || limits.UploadWindowLog > 23
           || limits.DownloadWindowLog < 10 || limits.DownloadWindowLog > 23 then
            invalidArg "limits" "Compression window logs must be between 10 and 23."
        if limits.MaxStreams < 1 || limits.MaxStreams > 256 then
            invalidArg "limits" "Stream count must be between 1 and 256."
        if limits.StreamWindowBytes < 16384 || limits.StreamWindowBytes > 4 * 1024 * 1024
           || int64 limits.StreamWindowBytes * int64 limits.MaxStreams > 64L * 1024L * 1024L then
            invalidArg "limits" "Stream windows must fit the 64 MiB session body budget."
        limits

    let negotiate offered allowed =
        { UploadWindowLog = min offered.UploadWindowLog allowed.UploadWindowLog
          DownloadWindowLog = min offered.DownloadWindowLog allowed.DownloadWindowLog
          MaxStreams = min offered.MaxStreams allowed.MaxStreams
          StreamWindowBytes = min offered.StreamWindowBytes allowed.StreamWindowBytes }
        |> validate

    type ClientOptions =
        { Listen: IPEndPoint
          Server: Uri
          Password: string
          Limits: Limits
          ConnectTimeout: TimeSpan }

    type ServerOptions =
        { Listen: IPEndPoint
          Password: string
          Limits: Limits
          MaxTunnels: int
          HandshakeTimeout: TimeSpan }

    let client listen server password =
        { Listen = listen
          Server = server
          Password = password
          Limits = defaults
          ConnectTimeout = TimeSpan.FromSeconds(15.0) }

    let server listen password =
        { Listen = listen
          Password = password
          Limits = defaults
          MaxTunnels = 16
          HandshakeTimeout = TimeSpan.FromSeconds(15.0) }
