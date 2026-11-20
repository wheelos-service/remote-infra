export interface CameraFeedTrack {
  attach(element: HTMLVideoElement): HTMLMediaElement
  detach(element: HTMLVideoElement): HTMLMediaElement[]
}

export interface CameraFeedOptions {
  requireFrameCallback?: boolean
}

export const CAMERA_FRAME_TIMEOUT_MS = 1000

export function bindCameraFeed(track: CameraFeedTrack, video: HTMLVideoElement,
  changed: (live: boolean) => void, options?: CameraFeedOptions): () => void {
  let stopped = false
  let live = false
  let lastFrame = -Infinity
  let lastRtpTimestamp: number | undefined
  let lastPresentedFrames: number | undefined
  let frameId: number | undefined
  const report = (value: boolean) => {
    if (stopped || live === value) return
    live = value
    changed(value)
  }
  const fresh = () => {
    lastFrame = performance.now()
    report(true)
  }
  const frame = (_now?: number, metadata?: VideoFrameCallbackMetadata) => {
    if (stopped) return
    let progressed = true
    if (metadata) {
      if (typeof metadata.rtpTimestamp === 'number') {
        progressed = metadata.rtpTimestamp !== lastRtpTimestamp
        lastRtpTimestamp = metadata.rtpTimestamp
      } else if (typeof metadata.presentedFrames === 'number') {
        progressed = metadata.presentedFrames !== lastPresentedFrames
        lastPresentedFrames = metadata.presentedFrames
      }
    }
    if (progressed) fresh()
    frameId = video.requestVideoFrameCallback(frame)
  }
  const hasCallback = typeof video.requestVideoFrameCallback === 'function'
  const allowFallback = !options?.requireFrameCallback
  const progress = () => {
    if (!hasCallback && allowFallback && video.readyState >= 2) fresh()
  }
  const stalled = () => { lastFrame = -Infinity; report(false) }
  const events = ['waiting', 'stalled', 'ended', 'error', 'emptied'] as const
  video.muted = true
  video.autoplay = true
  video.playsInline = true
  if (allowFallback) video.addEventListener('timeupdate', progress)
  for (const event of events) video.addEventListener(event, stalled)
  track.attach(video)
  if (hasCallback) frameId = video.requestVideoFrameCallback(frame)
  const timer = setInterval(() => {
    if (performance.now() - lastFrame >= CAMERA_FRAME_TIMEOUT_MS) report(false)
  }, 100)
  return () => {
    if (stopped) return
    report(false)
    stopped = true
    clearInterval(timer)
    if (frameId !== undefined) video.cancelVideoFrameCallback(frameId)
    if (allowFallback) video.removeEventListener('timeupdate', progress)
    for (const event of events) video.removeEventListener(event, stalled)
    track.detach(video)
  }
}

export function threeCamerasReady(frames: Readonly<Partial<Record<string, boolean>>>): boolean {
  return ['left', 'center', 'right'].every(name => frames[name] === true)
}
