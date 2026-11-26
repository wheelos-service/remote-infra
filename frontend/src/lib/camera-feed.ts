export interface CameraFeedTrack {
  lookupFrameMetadata?(frame: {rtpTimestamp: number}): {userData?: Uint8Array} | undefined
  getRTCStatsReport?(): Promise<RTCStatsReport | undefined>
  attach(element: HTMLVideoElement): HTMLMediaElement
  detach(element: HTMLVideoElement): HTMLMediaElement[]
}

export interface CameraFrameStats {
  emaIntervalMs: number
  stallBudgetMs: number
  maxIntervalMs: number
  lastIntervalMs: number
  lastResidenceMs?: number
}

export interface CameraFeedOptions {
  requireFrameCallback?: boolean
  maxResidenceMs?: number
  onPresented?: (count: number | undefined) => void
  onFrame?: (rtpTimestamp?: number) => void
  onStats?: (stats: CameraFrameStats) => void
}

export const CAMERA_FRAME_TIMEOUT_MS = 1500
const CAMERA_FRAME_MIN_STALL_MS = 900

export function adaptiveFrameStallMs(emaIntervalMs: number, sampleCount: number): number {
  if (sampleCount < 3 || !Number.isFinite(emaIntervalMs) || emaIntervalMs <= 0) {
    return CAMERA_FRAME_TIMEOUT_MS
  }
  return Math.round(Math.min(CAMERA_FRAME_TIMEOUT_MS, Math.max(CAMERA_FRAME_MIN_STALL_MS, emaIntervalMs * 6)))
}

export function bindCameraFeed(track: CameraFeedTrack, video: HTMLVideoElement,
  changed: (live: boolean) => void, options?: CameraFeedOptions): () => void {
  let stopped = false
  let live = false
  let lastFrame = -Infinity
  let lastRtpTimestamp: number | undefined
  let lastPresentedFrames: number | undefined
  let emaIntervalMs = 0
  let maxIntervalMs = 0
  let lastIntervalMs = 0
  let lastResidenceMs: number | undefined
  let intervalSamples = 0
  let rejectedSamples = 0
  let stallBudgetMs = CAMERA_FRAME_TIMEOUT_MS
  let frameId: number | undefined
  const emitStats = () => {
    options?.onStats?.({
      emaIntervalMs: Math.round(emaIntervalMs),
      stallBudgetMs,
      maxIntervalMs: Math.round(maxIntervalMs),
      lastIntervalMs: Math.round(lastIntervalMs),
      ...(lastResidenceMs !== undefined ? { lastResidenceMs: Math.round(lastResidenceMs) } : {}),
    })
  }
  const report = (value: boolean) => {
    if (stopped || live === value) return
    live = value
    if (!value && intervalSamples > 0) emitStats()
    changed(value)
  }
  const fresh = (rtpTimestamp?: number) => {
    const now = performance.now()
    if (Number.isFinite(lastFrame)) {
      const delta = Math.max(0, now - lastFrame)
      lastIntervalMs = delta
      maxIntervalMs = Math.max(maxIntervalMs, delta)
      emaIntervalMs = intervalSamples === 0 ? delta : emaIntervalMs * 0.75 + delta * 0.25
      intervalSamples++
      stallBudgetMs = adaptiveFrameStallMs(emaIntervalMs, intervalSamples)
      if (intervalSamples % 30 === 0) emitStats()
    }
    lastFrame = now
    report(true)
    options?.onFrame?.(rtpTimestamp)
  }
  const frame = (now?: number, metadata?: VideoFrameCallbackMetadata) => {
    if (stopped) return
    const callbackNow = typeof now === 'number' && Number.isFinite(now) ? now : performance.now()
    options?.onPresented?.(metadata?.presentedFrames)
    let progressed = true
    if (metadata) {
      if (typeof metadata.rtpTimestamp === 'number') {
        progressed = metadata.rtpTimestamp !== lastRtpTimestamp
        lastRtpTimestamp = metadata.rtpTimestamp
      } else if (typeof metadata.presentedFrames === 'number') {
        progressed = metadata.presentedFrames !== lastPresentedFrames
        lastPresentedFrames = metadata.presentedFrames
      }
      if (progressed && typeof metadata.receiveTime === 'number' && Number.isFinite(metadata.receiveTime)) {
        const renderTime = typeof metadata.presentationTime === 'number' && Number.isFinite(metadata.presentationTime)
          ? metadata.presentationTime : callbackNow
        lastResidenceMs = Math.max(0, renderTime - metadata.receiveTime, callbackNow - metadata.receiveTime)
        const residenceLimit = options?.maxResidenceMs ?? stallBudgetMs
        if (lastResidenceMs > residenceLimit) {
          if (options?.maxResidenceMs !== undefined) report(false)
          progressed = false
          if (rejectedSamples++ % 30 === 0) emitStats()
        }
      }
    }
    if (progressed) fresh(metadata?.rtpTimestamp)
    frameId = video.requestVideoFrameCallback(frame)
  }
  const hasCallback = typeof video.requestVideoFrameCallback === 'function'
  const allowFallback = !options?.requireFrameCallback
  const progress = () => {
    if (!hasCallback && allowFallback && video.readyState >= 2) fresh()
  }
  const stalled = () => { lastFrame = -Infinity; report(false) }
  const terminalEvents = ['ended', 'error', 'emptied'] as const
  video.muted = true
  video.autoplay = true
  video.playsInline = true
  if (allowFallback) video.addEventListener('timeupdate', progress)
  for (const event of terminalEvents) video.addEventListener(event, stalled)
  track.attach(video)
  if (hasCallback) frameId = video.requestVideoFrameCallback(frame)
  const timer = setInterval(() => {
    if (performance.now() - lastFrame >= stallBudgetMs) report(false)
  }, 100)
  return () => {
    if (stopped) return
    report(false)
    stopped = true
    clearInterval(timer)
    if (frameId !== undefined) video.cancelVideoFrameCallback(frameId)
    if (allowFallback) video.removeEventListener('timeupdate', progress)
    for (const event of terminalEvents) video.removeEventListener(event, stalled)
    track.detach(video)
  }
}

export function threeCamerasReady(frames: Readonly<Partial<Record<string, boolean>>>): boolean {
  return ['left', 'center', 'right'].every(name => frames[name] === true)
}
