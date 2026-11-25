import { useCallback, useEffect, useRef, useState } from 'react'
import { captureDeadline, decodeCaptureStamp, readGeneratedFrame, type BenchClock } from '../lib/bench-camera'
import { organizationHeaders, requestOrganization } from '../lib/organization-context'
import { teleopConfig } from '../lib/teleop-config'
import type { CameraFeedTrack } from '../lib/camera-feed'
import type { FrontCamera } from '../lib/camera-view'
import type { TeleopDiagnosticsBuffer } from '../lib/teleop-diagnostics'

import { BenchVideoStats } from '../lib/bench-video-stats'

const names = ['left', 'center', 'right'] as const
type Tracks = Partial<Record<FrontCamera, CameraFeedTrack>>

export function useBenchCameras(vehicle: string, bearer: string, requested: boolean, connected: boolean,
  tracks: Tracks, frames: Tracks, diagnostics: TeleopDiagnosticsBuffer) {
  const [eligible, setEligible] = useState(false)
  const receiverUntil = useRef(0)
  const [receiverReady, setReceiverReady] = useState(false)
  const [ready, setReady] = useState(false)
  const clock = useRef<BenchClock | undefined>(undefined)
  const samples = useRef(new Map<CameraFeedTrack, { until: number; stamp: number; since: number }>())
  const canvas = useRef<CanvasRenderingContext2D | null>(null)
  const current = useRef({connected, tracks, frames})
  current.current = {connected, tracks, frames}
  const windows = useRef(new Map<string, BenchVideoStats>())
  useEffect(() => {
    if (!eligible) return
    for (const name of names) windows.current.set(name, new BenchVideoStats(performance.now()))
    const timer = setInterval(() => {
      const now = performance.now()
      for (const name of names) {
        const stats = windows.current.get(name)!
        const window = stats.window(name, now)
        diagnostics.recordWindow(window)
        void stats.transportDelta(current.current.tracks[name]).then(delta => {window.transport = delta}).catch(() => {})
      }
    }, 10000)
    return () => { clearInterval(timer); windows.current.clear() }
  }, [eligible, diagnostics])
  const present = useCallback((name: FrontCamera, track: CameraFeedTrack, count?: number) => {
    if (current.current.tracks[name] === track) windows.current.get(name)?.present(track, count, performance.now())
  }, [])
  const check = useCallback(() => {
    const now = performance.now()
    const {connected, tracks, frames} = current.current
    return !document.hidden && connected && names.every(name => {
      const track = tracks[name]
      const sample = track && samples.current.get(track)
      return sample && frames[name] === track && sample.until > now && now - sample.since >= 1000
    })
  }, [])
  useEffect(() => {
    if (!requested) return
    const abort = new AbortController()
    let timer: ReturnType<typeof setTimeout>
    async function sync() {
      const started = performance.now()
      try {
        const response = await fetch(teleopConfig.gatewayUrl.replace(/\/$/, '') +
          '/api/vehicles/' + encodeURIComponent(vehicle) + '/control/bench-clock', {
          cache: 'no-store', headers: {Authorization: 'Bearer ' + bearer, ...organizationHeaders(requestOrganization())},
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2000)]),
        })
        if (response.status === 403) {
          clock.current = undefined
          receiverUntil.current = 0
          samples.current.clear()
          return
        }
        if (!response.ok) throw new Error('clock unavailable')
        const data = await response.json()
        if (abort.signal.aborted) return
        if (Number.isSafeInteger(data.epoch) && data.epoch > 0 && Number.isSafeInteger(data.elapsed_ms) && data.elapsed_ms >= 0) {
          if (clock.current?.epoch !== data.epoch) samples.current.clear()
          clock.current = {epoch: data.epoch, elapsed_ms: data.elapsed_ms, started, received: performance.now()}
          receiverUntil.current = Number.isSafeInteger(data.receiver_ttl_ms) ? started + Math.min(data.receiver_ttl_ms, 5000) : 0
          setEligible(true)
        }
      } catch { /* Existing samples expire on the monotonic deadline. */ }
      if (!abort.signal.aborted) timer = setTimeout(sync, 2000)
    }
    void sync()
    const poll = setInterval(() => { setReady(check()); setReceiverReady(performance.now() < receiverUntil.current) }, 25)
    return () => {
      abort.abort(); clearTimeout(timer); clearInterval(poll)
      clock.current = undefined; samples.current.clear(); setReady(false); setEligible(false)
    }
  }, [vehicle, bearer, requested, check])
  const invalidate = useCallback((track?: CameraFeedTrack) => {
    if (track) samples.current.delete(track)
    setReady(check())
  }, [check])
  useEffect(() => {
    if (!connected) { samples.current.clear(); setReady(false) }
    for (const track of samples.current.keys()) if (!Object.values(tracks).includes(track)) samples.current.delete(track)
  }, [connected, tracks])
  const sample = useCallback((name: FrontCamera, track: CameraFeedTrack, video: HTMLVideoElement, rtpTimestamp?: number) => {
    const sync = clock.current
    if (!sync || !current.current.connected || current.current.tracks[name] !== track || name === 'front') return
    const camera = names.indexOf(name)
    const metadata = rtpTimestamp === undefined ? undefined : track.lookupFrameMetadata?.({rtpTimestamp})
    let stamp: number | undefined
    if (metadata) {
      if (metadata.userData) stamp = decodeCaptureStamp(metadata.userData, camera, sync.epoch)
    } else {
      if (!canvas.current) {
        const element = document.createElement('canvas')
        element.width = 96; element.height = 1
        canvas.current = element.getContext('2d', {willReadFrequently: true})
      }
      try {
        if (canvas.current) stamp = readGeneratedFrame(video, canvas.current, camera, sync.epoch)
      } catch { /* An unreadable sample invalidates this track below. */ }
    }
    const now = performance.now()
    const previous = samples.current.get(track)
    const until = stamp === undefined ? 0 : captureDeadline(sync, stamp, now)
    if (previous && stamp === previous.stamp && previous.until > now) return
    if (!until || stamp === undefined || previous && stamp < previous.stamp) {
      if (previous) diagnostics.record('video','generated_frame_rejected',name)
      invalidate(track)
      return
    }
    windows.current.get(name)?.age(1000 - (until - now) * 1.001)
    samples.current.set(track, {until, stamp, since: previous && previous.until > now ? previous.since : now})
  }, [diagnostics, invalidate])
  return {eligible, ready, receiverReady, sample, present, check, invalidate}
}
