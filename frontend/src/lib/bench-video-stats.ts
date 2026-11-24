import type { CameraFeedTrack } from './camera-feed'

export interface BenchVideoWindow {
  camera: string; start_ms: number; duration_ms: number; presented: number; fps: number
  verified: number; age_p50_ms: number | null; age_p95_ms: number | null; age_p99_ms: number | null; age_max_ms: number | null
  longest_gap_ms: number; transport?: Partial<Record<TransportMetric, number>>
}
const counters = ['framesReceived', 'framesDecoded', 'framesDropped', 'packetsLost',
  'jitterBufferDelay', 'jitterBufferEmittedCount'] as const
type TransportMetric = typeof counters[number]
type Totals = Partial<Record<TransportMetric, number>>
export class BenchVideoStats {
  private ages: number[] = []
  private count = 0
  private last: number
  private longest = 0
  private track?: CameraFeedTrack
  private previousCount?: number
  private transport?: {id: string; totals: Totals}
  constructor(private start: number) { this.last = start }

  present(track: CameraFeedTrack, count: number | undefined, now: number) {
    if (count === undefined || !Number.isSafeInteger(count) || count < 1) return
    const delta = track === this.track && this.previousCount !== undefined && count >= this.previousCount
      ? count - this.previousCount : 1
    this.track = track
    this.previousCount = count
    if (!delta) return
    this.count += delta
    this.longest = Math.max(this.longest, now - this.last)
    this.last = now
  }
  age(value: number) { if (this.ages.length < 1200) this.ages.push(value) }
  window(camera: string, now: number): BenchVideoWindow {
    const ages = this.ages.sort((a,b) => a-b)
    const percentile = (p: number) => ages.length ? Math.ceil(ages[Math.ceil(ages.length*p)-1]) : null
    const duration = now - this.start
    const result = {camera, start_ms: this.start, duration_ms: duration, presented: this.count,
      fps: duration > 0 ? this.count * 1000 / duration : 0, verified: ages.length,
      age_p50_ms: percentile(.5), age_p95_ms: percentile(.95), age_p99_ms: percentile(.99), age_max_ms: percentile(1),
      longest_gap_ms: Math.ceil(Math.max(this.longest, now - this.last))}
    this.count = 0; this.ages = []; this.longest = 0; this.start = now
    return result
  }
  async transportDelta(track?: CameraFeedTrack): Promise<Totals | undefined> {
    const stats = await track?.getRTCStatsReport?.()
    let result: Totals | undefined
    stats?.forEach(value => {
      if (value.type !== 'inbound-rtp' || value.kind !== 'video') return
      const totals: Totals = {}
      const delta: Totals = {}
      for (const key of counters) {
        const v = value[key]
        if (typeof v !== 'number' || !Number.isFinite(v)) continue
        totals[key] = v
        const prev = this.transport?.totals[key]
        if (this.transport?.id === value.id && prev !== undefined) delta[key] = v - prev
      }
      this.transport = {id: value.id, totals}
      result = delta
    })
    return result
  }
}
