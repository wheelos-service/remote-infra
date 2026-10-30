import type { VehicleDirectoryEntry, VehicleTelemetry } from './vehicles-api'

export type TelemetryFreshnessState = 'fresh' | 'stale' | 'unknown' | 'clock-error'

export interface SampleFreshness {
  receiptAgeMs: number | null
  sourceAgeMs: number | null
  callbackAgeMs: number | null
  gatewayStateAgeMs: number | null
  publisherTransitAgeMs: number | null
  state: TelemetryFreshnessState
}

export interface ReceivedVehicle extends VehicleDirectoryEntry {
  /** Monotonic request start: includes the full fetch RTT as a conservative age bound. */
  receivedAtClientMs: number
  receivedAtWallMs: number
}

const FRESH_SAMPLE_MAX_AGE_MS = 5_000
const CLOCK_FUTURE_TOLERANCE_MS = 5_000
export const VEHICLE_ONLINE_MAX_AGE_MS = 10_000

export function getSampleFreshness(
  sample: VehicleTelemetry['chassis'] | VehicleTelemetry['localization'] | undefined,
  entry: ReceivedVehicle,
  nowMs: number,
): SampleFreshness {
  const receiptAgeMs = Math.max(0, nowMs - entry.receivedAtClientMs)
  const unknown: SampleFreshness = {
    receiptAgeMs,
    sourceAgeMs: null,
    callbackAgeMs: null,
    gatewayStateAgeMs: null,
    publisherTransitAgeMs: null,
    state: 'unknown',
  }
  if (!sample || !entry.state) return unknown

  const serverAge = (timestamp: number | null): number | null => {
    if (timestamp === null) return null
    const ageAtResponse = entry.server_time_ms - timestamp
    if (ageAtResponse < -CLOCK_FUTURE_TOLERANCE_MS) return Number.NEGATIVE_INFINITY
    return Math.max(0, ageAtResponse) + receiptAgeMs
  }

  const gatewayStateAgeMs =
    entry.received_at_ms === null ? null : serverAge(entry.received_at_ms)
  const publisherTransitAgeMs = serverAge(entry.state.published_at_ms)
  const sourceAgeMs = serverAge(sample.source_timestamp_ms)
  const callbackAgeMs =
    sample.age_ms === null
      ? null
      : sample.age_ms + Math.max(gatewayStateAgeMs ?? 0, publisherTransitAgeMs ?? 0)

  const ageValues = [gatewayStateAgeMs, publisherTransitAgeMs, sourceAgeMs, callbackAgeMs]
  if (ageValues.some((age) => age === Number.NEGATIVE_INFINITY)) {
    return {
      receiptAgeMs,
      sourceAgeMs: null,
      callbackAgeMs,
      gatewayStateAgeMs: null,
      publisherTransitAgeMs: null,
      state: 'clock-error',
    }
  }

  const knownAges = ageValues.filter((age): age is number => age !== null)
  const conservativeAge = knownAges.length ? Math.max(...knownAges) : null
  const state =
    sample.source_timestamp_ms === null
      ? 'unknown'
      : conservativeAge === null
        ? 'unknown'
        : conservativeAge <= FRESH_SAMPLE_MAX_AGE_MS
          ? 'fresh'
          : 'stale'

  return {
    receiptAgeMs,
    sourceAgeMs: conservativeAge,
    callbackAgeMs,
    gatewayStateAgeMs,
    publisherTransitAgeMs,
    state,
  }
}

export function directoryOnline(
  entry: ReceivedVehicle,
  requestFailed: boolean,
  nowMs: number,
): boolean {
  const responseAgeMs = nowMs - entry.receivedAtClientMs
  const gatewayAgeMs =
    entry.received_at_ms === null ? null : entry.server_time_ms - entry.received_at_ms
  return (
    !requestFailed &&
    entry.online &&
    gatewayAgeMs !== null &&
    gatewayAgeMs >= 0 &&
    responseAgeMs >= 0 &&
    gatewayAgeMs + responseAgeMs <= VEHICLE_ONLINE_MAX_AGE_MS
  )
}

export function directoryControl(
  entry: ReceivedVehicle,
  requestFailed: boolean,
  nowMs: number,
): VehicleDirectoryEntry['control'] {
  const responseAgeMs = nowMs - entry.receivedAtClientMs
  if (requestFailed || responseAgeMs < 0 || responseAgeMs > VEHICLE_ONLINE_MAX_AGE_MS) {
    return { status: 'unknown', is_self: false }
  }
  return entry.control
}

export function displayTelemetryValue(value: number | null | undefined, digits = 1): string {
  return value === null || value === undefined || !Number.isFinite(value)
    ? '未知'
    : value.toFixed(digits)
}
