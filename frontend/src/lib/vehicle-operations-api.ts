import { z } from 'zod'
import { teleopConfig } from './teleop-config'
import { chassisMessageSchema, localizationMessageSchema } from './vehicles-api'
import type { PreviewScenario } from './preview-vehicles'

const age = z.number().int().safe().nonnegative()
const timestamp = age.min(1)
const nullableTimestamp = timestamp.nullable()
const vehicleId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)

export const diagnosticIssueSchema = z.object({
  code: z.string(),
  severity: z.enum(['warning', 'critical']),
  message: z.string(),
}).strict()

export const vehicleAlertSchema = z.object({
  event_id: z.string().regex(/^[a-f0-9]{64}$/),
  occurred_at_ms: timestamp,
  severity: z.enum(['info', 'warning', 'critical']),
  code: z.string().min(1).max(128),
  message: z.string().min(1).max(2048),
  status: z.enum(['open', 'resolved']),
  resolved_at_ms: nullableTimestamp,
}).strict()

export const vehicleMissionSchema = z.object({
  mission_id: vehicleId,
  status: z.enum(['unknown', 'accepted', 'running', 'succeeded', 'failed', 'canceled']),
  updated_at_ms: timestamp,
  description: z.string().refine((value) => new TextEncoder().encode(value).length <= 2048),
}).strict()

export const vehicleHistorySchema = z.object({
  stream_id: vehicleId,
  sequence: timestamp,
  published_at_ms: timestamp,
  received_at_ms: timestamp,
  chassis: chassisMessageSchema.nullable(),
  localization: localizationMessageSchema.nullable(),
}).strict()

export const vehicleOperationsSchema = z.object({
  vehicle_id: vehicleId,
  server_time_ms: timestamp,
  diagnostics: z.object({
    source: z.literal('telemetry'),
    chassis_received: z.boolean(),
    localization_received: z.boolean(),
    chassis_age_ms: age.nullable(),
    localization_age_ms: age.nullable(),
    source_timestamp_ms: nullableTimestamp,
    issues: z.array(diagnosticIssueSchema),
  }).strict(),
  alerts: z.array(vehicleAlertSchema).max(100),
  missions: z.array(vehicleMissionSchema).max(100),
  history: z.array(vehicleHistorySchema).max(300),
  capabilities: z.object({
    mission_commands: z.literal(false),
    geographic_projection: z.literal(false),
    driving: z.literal(false),
  }).strict(),
}).strict()

export type VehicleOperations = z.infer<typeof vehicleOperationsSchema>
export type VehicleAlert = z.infer<typeof vehicleAlertSchema>
export type VehicleMission = z.infer<typeof vehicleMissionSchema>
export type VehicleHistorySample = z.infer<typeof vehicleHistorySchema>

export function conservativeAgeMs(
  sampleAgeMs: number | null,
  requestStartedAtMs: number | undefined,
  nowMs: number,
): number | null {
  if (sampleAgeMs === null || requestStartedAtMs === undefined) return sampleAgeMs
  return sampleAgeMs + Math.max(0, nowMs - requestStartedAtMs)
}

export function recentHistoryWithMarkers(history: VehicleHistorySample[], limit = 10) {
  const recent = [...history]
    .sort((a, b) => a.received_at_ms - b.received_at_ms || a.sequence - b.sequence)
    .slice(-limit)
    .reverse()
  return recent.map((sample, index) => {
    const older = recent[index + 1]
    let marker: { kind: 'stream' | 'gap'; label: string } | undefined
    if (older && sample.stream_id !== older.stream_id) {
      marker = {
        kind: 'stream',
        label: `流切换：${older.stream_id} → ${sample.stream_id}`,
      }
    } else if (older && sample.stream_id === older.stream_id &&
        sample.sequence > older.sequence + 1) {
      marker = {
        kind: 'gap',
        label: `序号缺口：#${older.sequence} → #${sample.sequence}（缺 ${sample.sequence - older.sequence - 1} 条）`,
      }
    } else if (older && sample.stream_id === older.stream_id &&
        sample.sequence <= older.sequence) {
      marker = {
        kind: 'gap',
        label: `序号顺序异常：#${older.sequence} → #${sample.sequence}`,
      }
    }
    return { sample, marker }
  })
}

export class VehicleOperationsApiError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message)
    this.name = 'VehicleOperationsApiError'
  }
}

export const OPERATIONS_REQUEST_TIMEOUT_MS = 8_000
export const OPERATIONS_POLL_INTERVAL_MS = 10_000
const gatewayUrl = teleopConfig.gatewayUrl.replace(/\/$/, '')

export async function fetchVehicleOperations(
  id: string,
  bearer: string,
  signal?: AbortSignal,
): Promise<VehicleOperations> {
  vehicleId.parse(id)
  const controller = new AbortController()
  let timedOut = false
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) controller.abort()
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, OPERATIONS_REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(
      `${gatewayUrl}/api/vehicles/${encodeURIComponent(id)}/operations`,
      {
        headers: { Authorization: `Bearer ${bearer}` },
        signal: controller.signal,
        cache: 'no-store',
      },
    )
    if (!response.ok) {
      const detail = (await response.text()).trim()
      const message = response.status === 401
        ? '业务数据认证已失效，请重新登录'
        : response.status === 403
          ? '当前账号无权查看该车辆业务数据'
          : detail || `车辆业务数据不可用 (${response.status})`
      throw new VehicleOperationsApiError(message, response.status)
    }

    let raw: unknown
    try {
      raw = await response.json()
    } catch (error) {
      if (controller.signal.aborted) throw error
      throw new VehicleOperationsApiError('车辆业务服务返回了无效 JSON')
    }
    const parsed = vehicleOperationsSchema.safeParse(raw)
    if (!parsed.success || parsed.data.vehicle_id !== id) {
      throw new VehicleOperationsApiError('车辆业务响应与预期数据格式不符')
    }
    return parsed.data
  } catch (error) {
    if (signal?.aborted) throw error
    if (timedOut) throw new VehicleOperationsApiError('车辆业务数据请求超时，将自动重试')
    if (error instanceof VehicleOperationsApiError) throw error
    throw new VehicleOperationsApiError('无法连接车辆业务数据服务')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
  }
}

export function createPreviewOperations(
  vehicle: string,
  nowMs = 1_793_333_000_000,
  scenario: PreviewScenario = 'default',
): VehicleOperations {
  const data = vehicleOperationsSchema.parse({
    vehicle_id: vehicle,
    server_time_ms: nowMs,
    diagnostics: {
      source: 'telemetry',
      chassis_received: true,
      localization_received: false,
      chassis_age_ms: 500,
      localization_age_ms: null,
      source_timestamp_ms: nowMs - 500,
      issues: [{
        code: 'LOCALIZATION_STALE',
        severity: 'warning',
        message: '预览场景：定位样本暂未收到',
      }],
    },
    alerts: [{
      event_id: 'a'.repeat(64),
      occurred_at_ms: nowMs - 60_000,
      severity: 'warning',
      code: 'LOCALIZATION_STALE',
      message: '预览场景：定位样本超过预期时间未更新',
      status: 'open',
      resolved_at_ms: null,
    }],
    missions: [{
      mission_id: `preview-${vehicle}-mission-1`,
      status: 'unknown',
      updated_at_ms: nowMs - 120_000,
      description: '预览任务状态未知；请勿据此推断车辆端执行结果',
    }],
    history: [{
      stream_id: 'preview-stream',
      sequence: 10,
      published_at_ms: nowMs - 1_000,
      received_at_ms: nowMs - 900,
      chassis: { speed_mps: 0, gear_location: 'GEAR_PARKING' },
      localization: null,
    }],
    capabilities: {
      mission_commands: false,
      geographic_projection: false,
      driving: false,
    },
  })
  if (scenario === 'default') return data
  data.diagnostics = {
    source: 'telemetry', chassis_received: true, localization_received: true,
    chassis_age_ms: 100, localization_age_ms: 100, source_timestamp_ms: nowMs - 100, issues: [],
  }
  data.alerts = []
  data.missions = []
  data.history[0] = {
    ...data.history[0], stream_id: 'preview-scenario',
    published_at_ms: nowMs - 100, received_at_ms: nowMs - 100,
    chassis: { speed_mps: 0, gear_location: 'GEAR_PARKING', error_code: 0 },
    localization: { position: { x: 10, y: 3, z: 0 }, frame_id: 'preview-map' },
  }
  if (scenario === 'reverse') {
    data.history[0].chassis = { speed_mps: 1, gear_location: 'GEAR_REVERSE', error_code: 0 }
  } else if (scenario === 'stale') {
    data.diagnostics.chassis_age_ms = data.diagnostics.localization_age_ms = 20_000
    data.diagnostics.source_timestamp_ms = nowMs - 20_000
    data.diagnostics.issues = [{ code: 'chassis_stale', severity: 'warning', message: '预览：旧样本，不代表当前状态' }]
    data.history[0].published_at_ms = data.history[0].received_at_ms = nowMs - 20_000
  } else if (scenario === 'missing') {
    data.diagnostics.chassis_received = data.diagnostics.localization_received = false
    data.diagnostics.chassis_age_ms = data.diagnostics.localization_age_ms = null
    data.diagnostics.source_timestamp_ms = null
    data.diagnostics.issues = [{ code: 'chassis_missing', severity: 'warning', message: '预览：尚未收到样本' }]
    data.history[0].chassis = data.history[0].localization = null
  } else if (scenario === 'clock') {
    data.diagnostics.chassis_age_ms = null
    data.diagnostics.source_timestamp_ms = nowMs + 60_000
    data.diagnostics.issues = [{ code: 'chassis_clock', severity: 'warning', message: '预览：源时间在未来' }]
  } else if (scenario === 'error' || scenario === 'recovered') {
    data.alerts = [{
      event_id: 'b'.repeat(64), occurred_at_ms: nowMs - 60_000, severity: 'critical',
      code: 'chassis_error_1', message: '预览：底盘错误转换',
      status: scenario === 'error' ? 'open' : 'resolved',
      resolved_at_ms: scenario === 'error' ? null : nowMs - 100,
    }]
    if (scenario === 'error') {
      data.history[0].chassis = { speed_mps: 0, gear_location: 'GEAR_PARKING', error_code: 1 }
      data.diagnostics.issues = [{ code: 'chassis_error', severity: 'critical', message: '预览：底盘报告错误' }]
    }
  } else if (scenario === 'history') {
    data.history = [
      { ...data.history[0], stream_id: 'preview-new', sequence: 1 },
      { ...data.history[0], sequence: 10, received_at_ms: nowMs - 12_000, published_at_ms: nowMs - 12_000 },
      { ...data.history[0], sequence: 7, received_at_ms: nowMs - 13_000, published_at_ms: nowMs - 13_000 },
    ]
  } else if (scenario === 'mission-unknown') {
    data.missions = [{
      mission_id: 'preview-mission', status: 'unknown', updated_at_ms: nowMs - 100,
      description: '预览：执行结果未知，不能推断成功或重发任务',
    }]
  }
  return vehicleOperationsSchema.parse(data)
}
