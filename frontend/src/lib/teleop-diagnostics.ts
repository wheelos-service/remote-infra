import type { BenchVideoWindow } from './bench-video-stats'

export type TeleopDiagnosticChannel = 'video' | 'control' | 'feedback'

export interface TeleopDiagnosticEntry {
  channel: TeleopDiagnosticChannel
  event: string
  monotonic_ms: number
  detail?: string
}

const MAX_TIMELINE_ENTRIES = 256

// Bounded in-browser ring buffer exported only to a local JSON download.
// Never store tokens, private keys, signatures, or raw command values here.
export class TeleopDiagnosticsBuffer {
  readonly videoWindows: BenchVideoWindow[] = []
  recordWindow(window: BenchVideoWindow) {
    this.videoWindows.push(window)
    if (this.videoWindows.length > 360) this.videoWindows.shift()
  }

  private readonly items: TeleopDiagnosticEntry[] = []

  record(channel: TeleopDiagnosticChannel, event: string, detail?: string): void {
    this.items.push({
      channel,
      event: event.slice(0, 48),
      monotonic_ms: performance.now(),
      ...(detail ? { detail: detail.slice(0, 64) } : {}),
    })
    if (this.items.length > MAX_TIMELINE_ENTRIES) this.items.shift()
  }

  entries(): TeleopDiagnosticEntry[] {
    return this.items.map(item => ({ ...item }))
  }

  clear(): void {
    this.items.length = 0
    this.videoWindows.length = 0
  }
}
