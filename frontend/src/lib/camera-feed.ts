export interface CameraFeedTrack {
  attach(element: HTMLVideoElement): HTMLMediaElement
  detach(element: HTMLVideoElement): HTMLMediaElement[]
  lookupFrameMetadata?(options: { rtpTimestamp: number }): { userTimestamp: bigint } | undefined
}

export const CAMERA_FRAME_TIMEOUT_MS = 1000
const LATENCY_UPDATE_INTERVAL_MS = 250
const CLOCK_JUMP_TOLERANCE_MS = 250

export function estimatedFrameLatency(
  track: CameraFeedTrack, metadata: VideoFrameCallbackMetadata | undefined, wallNow: number, monotonicNow: number,
): number | undefined {
  const rtpTimestamp = metadata?.rtpTimestamp
  if (typeof rtpTimestamp !== 'number' || !Number.isFinite(rtpTimestamp) ||
      !Number.isFinite(metadata?.expectedDisplayTime) || !Number.isFinite(wallNow) || !Number.isFinite(monotonicNow)) return
  if (monotonicNow - metadata!.expectedDisplayTime >= CAMERA_FRAME_TIMEOUT_MS) return
  const timestamp = track.lookupFrameMetadata?.({ rtpTimestamp })?.userTimestamp
  if (typeof timestamp !== 'bigint' || timestamp <= BigInt(0) || timestamp > BigInt(Number.MAX_SAFE_INTEGER)) return
  const latency = wallNow + (metadata!.expectedDisplayTime - monotonicNow) - Number(timestamp) / 1000
  return Number.isFinite(latency) && latency >= 0 ? latency : undefined
}

export function bindCameraFeed(track: CameraFeedTrack, video: HTMLVideoElement,
  changed: (live: boolean) => void, latencyChanged?: (latencyMs: number | undefined) => void): () => void {
  let stopped = false
  let live = false
  let lastFrame = -Infinity
  let frameId: number | undefined
  let latency: number | undefined
  let lastLatencyUpdate = -Infinity
  let lastClockOffset: number | undefined
  let clockJumped = false
  const reportLatency = (value: number | undefined, now: number) => {
    if (stopped || (value === undefined && latency === undefined)) return
    if (value !== undefined && latency !== undefined && now - lastLatencyUpdate < LATENCY_UPDATE_INTERVAL_MS) return
    latency = value
    lastLatencyUpdate = now
    latencyChanged?.(value)
  }
  const report = (value: boolean) => {
    if (stopped || live === value) return
    live = value
    changed(value)
  }
  const fresh = () => {
    lastFrame = performance.now()
    report(true)
  }
  const frame: VideoFrameRequestCallback = (_now, metadata) => {
    if (stopped) return
    fresh()
    if (latencyChanged) {
      const wallNow = Date.now()
      const monotonicNow = performance.now()
      const clockOffset = wallNow - monotonicNow
      if (lastClockOffset !== undefined && Math.abs(clockOffset - lastClockOffset) > CLOCK_JUMP_TOLERANCE_MS) {
        clockJumped = true
      }
      lastClockOffset = clockOffset
      reportLatency(clockJumped ? undefined : estimatedFrameLatency(track, metadata, wallNow, monotonicNow), monotonicNow)
    }
    frameId = video.requestVideoFrameCallback(frame)
  }
  const hasCallback = typeof video.requestVideoFrameCallback === 'function'
  const progress = () => {
    if (!hasCallback && video.readyState >= 2) fresh()
  }
  const stalled = () => { lastFrame = -Infinity; report(false); reportLatency(undefined, performance.now()) }
  const events = ['waiting', 'stalled', 'ended', 'error', 'emptied'] as const
  video.muted = true
  video.autoplay = true
  video.playsInline = true
  video.addEventListener('timeupdate', progress)
  for (const event of events) video.addEventListener(event, stalled)
  track.attach(video)
  if (hasCallback) frameId = video.requestVideoFrameCallback(frame)
  const timer = setInterval(() => {
    const now = performance.now()
    if (now - lastFrame >= CAMERA_FRAME_TIMEOUT_MS) { report(false); reportLatency(undefined, now) }
  }, 100)
  return () => {
    if (stopped) return
    report(false)
    reportLatency(undefined, performance.now())
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
