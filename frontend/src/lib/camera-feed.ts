export interface CameraFeedTrack {
  attach(element: HTMLVideoElement): HTMLMediaElement
  detach(element: HTMLVideoElement): HTMLMediaElement[]
}

export const CAMERA_FRAME_TIMEOUT_MS = 1000

export function bindCameraFeed(track: CameraFeedTrack, video: HTMLVideoElement,
  changed: (live: boolean) => void): () => void {
  let stopped = false
  let live = false
  let lastFrame = -Infinity
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
  const frame = () => {
    if (stopped) return
    fresh()
    frameId = video.requestVideoFrameCallback(frame)
  }
  const hasCallback = typeof video.requestVideoFrameCallback === 'function'
  const progress = () => {
    if (!hasCallback && video.readyState >= 2) fresh()
  }
  const stalled = () => { lastFrame = -Infinity; report(false) }
  const events = ['waiting', 'stalled', 'ended', 'error', 'emptied'] as const
  video.muted = true
  video.autoplay = true
  video.playsInline = true
  video.addEventListener('timeupdate', progress)
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
    video.removeEventListener('timeupdate', progress)
    for (const event of events) video.removeEventListener(event, stalled)
    track.detach(video)
  }
}

export function threeCamerasReady(frames: Readonly<Partial<Record<string, boolean>>>): boolean {
  return ['left', 'center', 'right'].every(name => frames[name] === true)
}
