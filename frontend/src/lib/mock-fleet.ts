import type { VehiclesState } from '../hooks/use-vehicles'
import { vehicleEntrySchema } from './vehicles-api'
import { createPreviewData, vehicleDataSchema, type VehicleData } from './vehicle-data-api'
import { lanePosition, type FleetMap } from './fleet-map'

export const mockVehicleNames = [
  '沿车道行驶', '停车', '倒车', '低电量 / 底盘故障',
  '定位源停更', 'Monitor 故障与恢复', '离线保留快照', '重启 / 任务结果未知',
] as const

export function createMockFleet(map: FleetMap, elapsedMs: number, startedAtMs: number, receivedAtClientMs: number): VehiclesState {
  const now = startedAtMs + elapsedMs
  const tick = Math.floor(elapsedMs / 500)
  return {
    status: 'ready', requestFailed: false, updatedAtWallMs: now,
    entries: mockVehicleNames.map((name, index) => {
      const vehicle = `sim-${String(index + 1).padStart(3, '0')}`
      const offline = index === 6
      const sampleTime = offline ? startedAtMs - 20_000 : now
      const generation = index === 7 ? Math.floor(elapsedMs / 30_000) : 0
      const sequence = offline ? 1 : index === 7 ? tick % 60 + 1 : tick + 1
      const points = map.lanes[index % map.lanes.length].center
      const speed = index === 1 || offline ? 0 : index === 2 ? 1 : 2
      const position = lanePosition(points, 10 * index + (offline || index === 4 ? 0 : elapsedMs / 1000 * speed))
      const stale = index === 4
      return {
        ...vehicleEntrySchema.parse({
          vehicle_id: vehicle, name: `${vehicle} · ${name}`,
          state: {
            schema_version: 1, type: 'vehicle_telemetry', vehicle_id: vehicle,
            stream_id: `mock-${map.id.slice(0, 32)}-${startedAtMs.toString(36)}-${index}-${generation}`,
            sequence, published_at_ms: sampleTime,
            chassis: {
              age_ms: 0, source_timestamp_ms: sampleTime, source_sequence: sequence,
              message: {
                speed_mps: speed,
                gear_location: speed === 0 ? 'GEAR_PARKING' : index === 2 ? 'GEAR_REVERSE' : 'GEAR_DRIVE',
                driving_mode: 'COMPLETE_AUTO_DRIVE', battery_soc_percentage: index === 3 ? 12 : 85 - index * 3,
                steering_percentage: 0, throttle_percentage: speed ? 10 : 0,
                brake_percentage: speed ? 0 : 20, parking_brake: speed === 0, error_code: index === 3 ? 1 : 0,
              },
            },
            localization: {
              age_ms: stale ? elapsedMs + 12_000 : 0,
              source_timestamp_ms: stale ? startedAtMs - 12_000 : sampleTime,
              source_sequence: stale ? 1 : sequence,
              message: {
                position: { x: position.x, y: position.y, z: 0 },
                heading_rad: index === 2 ? position.heading + Math.PI : position.heading, frame_id: map.frame_id,
              },
            },
          },
          received_at_ms: sampleTime, server_time_ms: now, online: !offline,
          control: { status: offline ? 'unknown' : 'free', is_self: false },
        }),
        receivedAtClientMs, receivedAtWallMs: now,
      }
    }),
  }
}

export function createMockVehicleData(vehicle: string, map: FleetMap, elapsedMs: number, startedAtMs: number): VehicleData {
  const index = Number(vehicle.slice(4)) - 1
  if (!/^sim-00[1-8]$/.test(vehicle)) throw new Error('Unknown mock vehicle')
  const now = startedAtMs + elapsedMs
  const data = createPreviewData(vehicle, now)
  data.can_manage = false
  if (!data.profile || !data.health) throw new Error('Missing mock data template')
  data.profile.payload.map_id = map.id
  data.profile.payload.model = 'Mock Fleet · 非真实车辆'
  data.profile.payload.task_mode = 'disabled'
  data.health.payload.sample.age_ms = index === 6 ? elapsedMs + 20_000 : 0
  data.health.payload.sample.source_timestamp_ms = index === 6 ? startedAtMs - 20_000 : now
  const message = data.health.payload.sample.message
  if (!message) throw new Error('Missing mock Monitor template')
  const recovered = index === 5 && elapsedMs >= 20_000
  const fault = index === 3 || index === 5 && !recovered
  message.hmi_modules = {
    chassis: { status: index === 3 ? 'ERROR' : 'OK', message: index === 3 ? '模拟底盘故障' : '模拟正常' },
    localization: { status: index === 4 ? 'UNKNOWN' : 'OK', message: index === 4 ? '模拟定位源过期' : '模拟正常' },
    monitor: { status: fault ? 'ERROR' : 'OK', message: fault ? '模拟故障' : '模拟正常' },
  }
  message.require_emergency_stop = fault
  if (index === 3) message.other_components.battery = { status: 'WARN', message: '模拟电量偏低' }
  data.events = fault || recovered ? [{
    schema_version: 1, type: 'vehicle_event', vehicle_id: vehicle, event_id: `mock-${index}-raised`,
    fault_key: 'hmi_modules/monitor', severity: 'ERROR', transition: 'raised',
    occurred_at_ms: startedAtMs, message: '模拟故障触发 · 不是真实车辆',
  }] : []
  if (recovered) data.events.push({
    schema_version: 1, type: 'vehicle_event', vehicle_id: vehicle, event_id: `mock-${index}-recovered`,
    fault_key: 'hmi_modules/monitor', severity: 'OK', transition: 'recovered',
    occurred_at_ms: startedAtMs + 20_000, message: '模拟明确恢复 · 不是真实车辆',
  })
  if (index === 3) {
    data.events.push({
      schema_version: 1, type: 'vehicle_event', vehicle_id: vehicle, event_id: 'mock-3-battery-raised',
      fault_key: 'other_components/battery', severity: 'WARN', transition: 'raised',
      occurred_at_ms: startedAtMs, message: '模拟电量偏低 · 剩余 12%',
    })
    if (elapsedMs >= 5000) data.events.push({
      schema_version: 1, type: 'vehicle_event', vehicle_id: vehicle, event_id: 'mock-3-changed',
      fault_key: 'hmi_modules/monitor', severity: 'ERROR', transition: 'changed',
      occurred_at_ms: startedAtMs + 5000, message: '模拟故障持续 · 需排查底盘',
    })
  }
  data.tasks = index === 7 ? [{
    request: {
      schema_version: 1, vehicle_id: vehicle, request_id: 'mock-query', client_epoch: 'mock-epoch',
      operation: 'query', created_at_ms: startedAtMs, expires_at_ms: startedAtMs + 60_000, map_id: map.id,
      parameters: { duration_ms: 0, target_request_id: 'mock-original', target_client_epoch: 'mock-epoch' },
    },
    result: { request_id: 'mock-query', report_sequence: 1, status: 'unknown', reason: '模拟结果未知，不能当作完成', mission_result: null },
  }] : []
  data.capacity.events_retained = data.events.length
  data.capacity.events_unacknowledged = data.events.length
  data.capacity.tasks_retained = data.tasks.length
  data.capacity.tasks_pending = data.tasks.length
  data.capacity.tasks_unknown = data.tasks.length
  return vehicleDataSchema.parse(data)
}
