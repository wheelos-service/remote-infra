import { z } from 'zod'
import { teleopConfig } from './teleop-config'
import { newViewingId as newRequestId } from './viewing-api'

const integer = z.number().int().safe().nonnegative()
const timestamp = integer.min(1)
export const dataIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
const text = (limit: number) => z.string().refine((value) => new TextEncoder().encode(value).length <= limit)
const severity = z.enum(['UNKNOWN', 'OK', 'WARN', 'ERROR', 'FATAL'])
const component = z.object({ status: severity.nullable(), message: text(256).nullable() }).strict().nullable()
const components = z.record(dataIdentifier, z.object({
  summary: component, process: component, channel: component,
  resource: component, other: component, module: component,
}).strict().nullable()).refine((value) => Object.keys(value).length <= 64)
const checks = z.record(dataIdentifier, component).refine((value) => Object.keys(value).length <= 64)
const envelope = {
  schema_version: z.literal(1), vehicle_id: dataIdentifier, stream_id: dataIdentifier,
  sequence: timestamp, published_at_ms: timestamp,
}
export const healthSchema = z.object({
  ...envelope, type: z.literal('vehicle_health'),
  sample: z.object({
    age_ms: integer.nullable(), source_timestamp_ms: integer.nullable(), source_sequence: integer.nullable(),
    message: z.object({
      components, hmi_modules: checks, other_components: checks, components_truncated: z.boolean(),
      require_emergency_stop: z.boolean().nullable(), is_realtime_in_simulation: z.boolean().nullable(),
      passenger_msg: text(512).nullable(), safety_mode_trigger_time: z.number().min(0).max(9e12).nullable(),
    }).strict().nullable(),
  }).strict(),
}).strict()
export const profileSchema = z.object({
  ...envelope, type: z.literal('vehicle_profile'), model: text(128),
  software_version: text(128), map_id: text(128),
  task_mode: z.enum(['disabled', 'simulation', 'mission_query']),
}).strict()
export const dataEventSchema = z.object({
  schema_version: z.literal(1), type: z.literal('vehicle_event'), vehicle_id: dataIdentifier,
  event_id: dataIdentifier, fault_key: text(256).refine((v) => v.length > 0),
  severity: z.enum(['OK', 'WARN', 'ERROR', 'FATAL']),
  transition: z.enum(['raised', 'changed', 'recovered']), occurred_at_ms: timestamp, message: text(512),
}).strict().refine((event) => (event.transition === 'recovered') === (event.severity === 'OK'))
export const dataTaskSchema = z.object({
  schema_version: z.literal(1), vehicle_id: dataIdentifier, request_id: dataIdentifier,
  client_epoch: dataIdentifier, operation: z.enum(['query', 'simulate_wait']),
  created_at_ms: timestamp, expires_at_ms: timestamp, map_id: text(128),
  parameters: z.object({
    duration_ms: integer.max(60_000),
    target_request_id: dataIdentifier.nullable(), target_client_epoch: dataIdentifier.nullable(),
  }).strict(),
}).strict().refine((task) => task.expires_at_ms > task.created_at_ms &&
  task.expires_at_ms - task.created_at_ms <= 86_400_000 &&
  (task.operation === 'query'
    ? task.parameters.duration_ms === 0 && task.parameters.target_request_id !== null && task.parameters.target_client_epoch !== null
    : task.parameters.duration_ms >= 1 && task.parameters.target_request_id === null && task.parameters.target_client_epoch === null))
const uint64 = z.string().regex(/^(0|[1-9][0-9]{0,19})$/)
  .refine((v) => v.length < 20 || v <= '18446744073709551615')
const commandIdentity = z.object({
  producer_epoch: text(128).nullable(), aggregate_id: text(128).nullable(),
  command_id: text(128).nullable(), revision: uint64.nullable(),
}).strict().nullable()
const missionResult = z.object({
  identity: z.object({ client_epoch: dataIdentifier, request_id: dataIdentifier }).strict(),
  requested_mission_id: text(2048).nullable(), outcome: text(64), code: text(64),
  reason: text(2048).nullable(), durably_committed: z.boolean().nullable(),
  commit_sequence: uint64.nullable(), retry_disposition: text(64).nullable(),
  terminal_disposition: text(64).nullable(),
  affected_task_identity: commandIdentity, current_task_identity: commandIdentity,
}).strict().nullable()
export const taskReportSchema = z.object({
  request_id: dataIdentifier, report_sequence: timestamp,
  status: z.enum(['received', 'reconciling', 'unknown', 'succeeded', 'rejected']),
  reason: text(512), mission_result: missionResult,
}).strict()
const taskRecord = z.object({ request: dataTaskSchema, result: taskReportSchema.nullable() }).strict()
  .refine((v) => !v.result || v.result.request_id === v.request.request_id)
const stored = <T extends z.ZodTypeAny>(payload: T) =>
  z.object({ payload, received_at_ms: timestamp }).strict().nullable()
const storeStatistics = z.object({
  capacity: integer.min(1).max(100_000), outbox_retained: integer, outbox_pending: integer,
  inbox_retained: integer, inbox_pending: integer, faults_retained: integer,
}).strict().refine((v) => v.outbox_pending <= v.outbox_retained && v.inbox_pending <= v.inbox_retained &&
  v.outbox_retained <= v.capacity && v.inbox_retained <= v.capacity && v.faults_retained <= v.capacity)
export const diagnosticsSchema = z.object({
  ...envelope, type: z.literal('vehicle_data_diagnostics'), store: storeStatistics,
}).strict()
const acknowledgement = z.object({
  event_id: dataIdentifier, operator_id: z.string(), acknowledged_at_ms: timestamp,
}).strict()
export const vehicleDataSchema = z.object({
  vehicle_id: dataIdentifier, server_time_ms: timestamp, can_manage: z.boolean(),
  health: stored(healthSchema), profile: stored(profileSchema), diagnostics: stored(diagnosticsSchema),
  events: z.array(dataEventSchema).max(100), tasks: z.array(taskRecord).max(100),
  acknowledgements: z.array(acknowledgement).max(100),
  capacity: z.object({
    events_retained: integer.max(10000), events_capacity: z.literal(10000),
    tasks_retained: integer.max(1000), tasks_capacity: z.literal(1000),
    tasks_pending: integer.max(1000), tasks_unknown: integer.max(1000),
    events_unacknowledged: integer.max(10000), capacity_warning: z.boolean(),
  }).strict(),
}).strict().superRefine((value, ctx) => {
  const vehicles = [
    value.health?.payload.vehicle_id, value.profile?.payload.vehicle_id, value.diagnostics?.payload.vehicle_id,
    ...value.events.map((v) => v.vehicle_id), ...value.tasks.map((v) => v.request.vehicle_id),
  ]
  if (vehicles.some((id) => id !== undefined && id !== value.vehicle_id)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Data vehicle identity mismatch' })
  }
})
export type VehicleData = z.infer<typeof vehicleDataSchema>
export type DataTask = z.infer<typeof dataTaskSchema>
export type DataEvent = z.infer<typeof dataEventSchema>

export class VehicleDataError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

const gateway = teleopConfig.gatewayUrl.replace(/\/$/, '')
async function request(vehicle: string, path: string, bearer: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal): Promise<Response> {
  dataIdentifier.parse(vehicle)
  const controller = new AbortController()
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) controller.abort()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; controller.abort() }, 8000)
  let abort: (() => void) | undefined
  try {
    return await Promise.race([(async () => {
      const response = await fetch(`${gateway}/api/vehicles/${encodeURIComponent(vehicle)}/data${path}`, {
        method, headers: { Authorization: `Bearer ${bearer}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: controller.signal, cache: 'no-store',
      })
      const raw = await response.text()
      if (!response.ok) {
        throw new VehicleDataError(response.status === 403 ? '当前账号无权执行此车辆操作'
          : response.status === 401 ? '认证已失效，请重新登录'
            : response.status === 507 ? '持久存储容量已满，需要归档处理'
              : raw.trim() || `车辆数据服务错误 (${response.status})`, response.status)
      }
      return new Response(raw || null, { status: response.status })
    })(), new Promise<never>((_, reject) => {
      abort = () => reject(new DOMException('Aborted', 'AbortError'))
      controller.signal.addEventListener('abort', abort, { once: true })
      if (controller.signal.aborted) abort()
    })])
  } catch (error) {
    if (signal?.aborted) throw error
    if (timedOut) throw new VehicleDataError(method === 'POST'
      ? '操作请求超时，结果未知；请刷新核实，勿生成新任务重复提交'
      : '车辆数据请求超时')
    if (error instanceof VehicleDataError) throw error
    throw new VehicleDataError(method === 'POST'
      ? '连接中断，操作结果未知；请刷新核实' : '无法连接车辆数据服务')
  } finally {
    clearTimeout(timer)
    if (abort) controller.signal.removeEventListener('abort', abort)
    signal?.removeEventListener('abort', cancel)
  }
}
export async function fetchVehicleData(vehicle: string, bearer: string, signal?: AbortSignal): Promise<VehicleData> {
  const response = await request(vehicle, '', bearer, 'GET', undefined, signal)
  let raw: unknown
  try { raw = await response.json() } catch { throw new VehicleDataError('车辆数据响应不是有效 JSON') }
  const value = vehicleDataSchema.safeParse(raw)
  if (!value.success || value.data.vehicle_id !== vehicle) throw new VehicleDataError('车辆数据格式或身份不匹配')
  return value.data
}
export async function acknowledgeDataEvent(vehicle: string, event: string, bearer: string, signal?: AbortSignal) {
  dataIdentifier.parse(event)
  const response = await request(vehicle, `/events/${encodeURIComponent(event)}/acknowledge`, bearer, 'POST', {}, signal)
  if (response.status !== 204) throw new VehicleDataError('告警确认未得到持久化确认')
}
export async function submitDataQuery(task: DataTask, bearer: string, signal?: AbortSignal) {
  dataTaskSchema.parse(task)
  if (task.operation !== 'query') throw new VehicleDataError('界面只开放只读 Mission 查询')
  const response = await request(task.vehicle_id, '/tasks', bearer, 'POST', task, signal)
  if (response.status !== 202) throw new VehicleDataError('任务未得到云端持久化确认')
}

export function newDataQuery(vehicle: string, map: string, targetEpoch: string, targetRequest: string, now = Date.now()): DataTask {
  return dataTaskSchema.parse({
    schema_version: 1, vehicle_id: vehicle, map_id: map,
    client_epoch: newRequestId(), request_id: newRequestId(), operation: 'query',
    created_at_ms: now, expires_at_ms: now + 60_000,
    parameters: { duration_ms: 0, target_client_epoch: targetEpoch, target_request_id: targetRequest },
  })
}

export function healthFreshness(data: VehicleData, elapsedMs: number): { fresh: boolean; age: number | null } {
  const health = data.health
  if (!health || !health.payload.sample.message || health.payload.sample.age_ms === null ||
      health.payload.sample.source_timestamp_ms === null) return { fresh: false, age: null }
  const { payload, received_at_ms: received } = health
  const future = payload.published_at_ms > data.server_time_ms + 100 ||
    payload.sample.source_timestamp_ms! > data.server_time_ms + 100 || received > data.server_time_ms + 100
  const age = Math.max(payload.sample.age_ms! + Math.max(0, data.server_time_ms - payload.published_at_ms),
    data.server_time_ms - payload.sample.source_timestamp_ms!,
    data.server_time_ms - received, 0) + Math.max(0, elapsedMs)
  return { fresh: !future && age <= 3000 && !payload.sample.message?.components_truncated, age }
}

const archiveAcknowledgement = z.object({ operator_id: z.string(), acknowledged_at_ms: timestamp }).strict().nullable()
const archivePage = z.object({
  vehicle_id: dataIdentifier, kind: z.enum(['events', 'tasks']), through: integer, next: integer, has_more: z.boolean(),
  records: z.array(z.union([
    z.object({ cursor: timestamp, payload: dataEventSchema, acknowledgement: archiveAcknowledgement }).strict(),
    z.object({ cursor: timestamp, payload: dataTaskSchema, result: taskReportSchema.nullable() }).strict(),
  ])).max(100),
}).strict()
export async function exportDataRecords(vehicle: string, kind: 'events' | 'tasks', bearer: string, signal?: AbortSignal): Promise<string> {
  let after = 0, through = 0
  const lines: string[] = []
  for (let pageNumber = 0; pageNumber < 101; ++pageNumber) {
    const response = await request(vehicle, `/records?kind=${kind}&after=${after}&through=${through}`, bearer, 'GET', undefined, signal)
    const page = archivePage.parse(await response.json())
    if (page.vehicle_id !== vehicle || page.kind !== kind || (through !== 0 && page.through !== through) ||
        page.next < after || page.next > page.through ||
        (page.has_more && page.next <= after)) throw new VehicleDataError('导出游标或车辆身份不匹配')
    let cursor = after
    for (const record of page.records) {
      if (record.payload.vehicle_id !== vehicle || record.cursor <= cursor || record.cursor > page.through ||
          (kind === 'events' ? !('acknowledgement' in record) : !('result' in record))) {
        throw new VehicleDataError('导出记录身份或顺序不匹配')
      }
      if ('result' in record && record.result && record.result.request_id !== record.payload.request_id) {
        throw new VehicleDataError('导出任务报告身份不匹配')
      }
      cursor = record.cursor
      lines.push(JSON.stringify(record))
    }
    if (page.next !== cursor) throw new VehicleDataError('导出记录不连续')
    if (!page.has_more) return lines.join('\n')
    after = page.next
    through = page.through
  }
  throw new VehicleDataError('导出超过容量边界，未生成不完整文件')
}

export function createPreviewData(vehicle: string): VehicleData {
  const now = 1793333000000
  const base = { schema_version: 1, vehicle_id: vehicle, stream_id: 'preview', sequence: 1, published_at_ms: now }
  return vehicleDataSchema.parse({
    vehicle_id: vehicle, server_time_ms: now, can_manage: false,
    profile: { received_at_ms: now, payload: { ...base, type: 'vehicle_profile', model: '预览车辆', software_version: 'preview', map_id: 'preview-map', task_mode: 'disabled' } },
    health: { received_at_ms: now, payload: { ...base, type: 'vehicle_health', sample: {
      age_ms: 100, source_timestamp_ms: now - 100, source_sequence: 1, message: {
        components: {}, hmi_modules: { localization: { status: 'WARN', message: '预览：定位质量降级' } },
        other_components: {}, components_truncated: false, require_emergency_stop: null,
        is_realtime_in_simulation: true, passenger_msg: null, safety_mode_trigger_time: null,
      },
    } } },
    diagnostics: null, events: [{ schema_version: 1, type: 'vehicle_event', vehicle_id: vehicle,
      event_id: 'preview-event', fault_key: 'hmi_modules/localization', severity: 'WARN',
      transition: 'raised', occurred_at_ms: now - 1000, message: '固定预览，不是真实告警' }],
    tasks: [], acknowledgements: [],
    capacity: { events_retained: 1, events_capacity: 10000, tasks_retained: 0, tasks_capacity: 1000,
      tasks_pending: 0, tasks_unknown: 0, events_unacknowledged: 1, capacity_warning: false },
  })
}
