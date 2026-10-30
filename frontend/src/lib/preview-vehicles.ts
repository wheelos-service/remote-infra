import { vehicleEntrySchema } from './vehicles-api'
import type { VehiclesState } from '../hooks/use-vehicles'
import type { ReceivedVehicle } from './vehicle-telemetry'

export const previewScenarios = [
  'default', 'parking', 'reverse', 'stale', 'missing', 'clock',
  'error', 'recovered', 'history', 'mission-unknown',
] as const
export type PreviewScenario = typeof previewScenarios[number]

export function selectedPreviewScenario(): PreviewScenario {
  const requested = new URLSearchParams(window.location.search).get('scenario') ?? 'default'
  const scenario = previewScenarios.find((value) => value === requested)
  if (!scenario) throw new Error(`Unknown preview scenario: ${requested}`)
  return scenario
}

export function createPreviewVehicles(
  nowMs = 1_793_333_000_000,
  scenario: PreviewScenario = 'default',
): VehiclesState {
  const entries: ReceivedVehicle[] = [
    {
      ...vehicleEntrySchema.parse({
        vehicle_id: 'AV-012',
        name: '预览车辆 · 东侧路',
        state: {
          schema_version: 1,
          type: 'vehicle_telemetry',
          vehicle_id: 'AV-012',
          stream_id: 'preview-stream-a',
          sequence: 10,
          published_at_ms: nowMs - 500,
          chassis: {
            age_ms: 500,
            source_timestamp_ms: nowMs - 500,
            source_sequence: 10,
            message: { speed_mps: 2, gear_location: 'GEAR_DRIVE', driving_mode: 'COMPLETE_AUTO_DRIVE' },
          },
          localization: {
            age_ms: 500,
            source_timestamp_ms: nowMs - 500,
            source_sequence: 10,
            message: { position: { x: 10, y: 3, z: 0 }, heading_rad: 1.2, frame_id: 'preview-map' },
          },
        },
        received_at_ms: nowMs - 300,
        server_time_ms: nowMs,
        online: true,
        control: { status: 'free', is_self: false },
      }),
      receivedAtClientMs: performance.now(),
      receivedAtWallMs: nowMs,
    },
    {
      ...vehicleEntrySchema.parse({
        vehicle_id: 'AV-019',
        name: '预览车辆 · 定位异常场景',
        state: {
          schema_version: 1,
          type: 'vehicle_telemetry',
          vehicle_id: 'AV-019',
          stream_id: 'preview-stream-b',
          sequence: 8,
          published_at_ms: nowMs - 12_000,
          chassis: {
            age_ms: 12_000,
            source_timestamp_ms: nowMs - 12_000,
            source_sequence: 8,
            message: { speed_mps: 0, gear_location: 'GEAR_PARKING' },
          },
          localization: {
            age_ms: null,
            source_timestamp_ms: null,
            source_sequence: null,
            message: null,
          },
        },
        received_at_ms: nowMs - 12_000,
        server_time_ms: nowMs,
        online: false,
        control: { status: 'unknown', is_self: false },
      }),
      receivedAtClientMs: performance.now(),
      receivedAtWallMs: nowMs,
    },
  ]

  if (scenario !== 'default') {
    for (const entry of entries) {
      const state = entry.state
      if (!state) throw new Error('Preview scenario requires a telemetry snapshot')
      state.stream_id = scenario === 'history' ? 'preview-new' : 'preview-scenario'
      state.sequence = scenario === 'history' ? 1 : 10
      entry.name = `预览车辆 · ${scenario}`
      entry.online = scenario !== 'stale'
      entry.received_at_ms = nowMs - (scenario === 'stale' ? 20_000 : 100)
      entry.control = { status: 'free', is_self: false }
      state.published_at_ms = entry.received_at_ms
      state.chassis = {
        age_ms: 0,
        source_timestamp_ms: state.published_at_ms,
        source_sequence: state.sequence,
        message: { speed_mps: 0, gear_location: 'GEAR_PARKING', error_code: 0 },
      }
      state.localization = {
        age_ms: 0, source_timestamp_ms: state.published_at_ms, source_sequence: state.sequence,
        message: { position: { x: 10, y: 3, z: 0 }, frame_id: 'preview-map' },
      }
      if (scenario === 'reverse') {
        state.chassis.message = { speed_mps: 1, gear_location: 'GEAR_REVERSE', error_code: 0 }
      } else if (scenario === 'missing') {
        state.chassis = { age_ms: null, source_timestamp_ms: null, source_sequence: null, message: null }
        state.localization = { age_ms: null, source_timestamp_ms: null, source_sequence: null, message: null }
      } else if (scenario === 'clock') {
        state.chassis.source_timestamp_ms = nowMs + 60_000
      } else if (scenario === 'error') {
        state.chassis.message = { speed_mps: 0, gear_location: 'GEAR_PARKING', error_code: 1 }
      }
      const { receivedAtClientMs, receivedAtWallMs, ...wireEntry } = entry
      vehicleEntrySchema.parse(wireEntry)
    }
  }

  return {
    entries,
    status: 'ready',
    updatedAtWallMs: nowMs,
    requestFailed: false,
  }
}
