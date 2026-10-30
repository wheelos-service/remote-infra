import { z } from 'zod'
import { teleopConfig } from './teleop-config'

const safeInteger = z.number().int().safe().nonnegative()
const nullableNumber = z.number().nullable()

export const chassisMessageSchema = z
  .object({
    speed_mps: nullableNumber.optional(),
    gear_location: z
      .enum([
        'GEAR_NEUTRAL',
        'GEAR_DRIVE',
        'GEAR_REVERSE',
        'GEAR_PARKING',
        'GEAR_LOW',
        'GEAR_INVALID',
        'GEAR_NONE',
      ])
      .nullable()
      .optional(),
    driving_mode: z
      .enum([
        'COMPLETE_MANUAL',
        'COMPLETE_AUTO_DRIVE',
        'AUTO_STEER_ONLY',
        'AUTO_SPEED_ONLY',
        'EMERGENCY_MODE',
      ])
      .nullable()
      .optional(),
    steering_percentage: z.number().min(-100).max(100).nullable().optional(),
    throttle_percentage: z.number().min(0).max(100).nullable().optional(),
    brake_percentage: z.number().min(0).max(100).nullable().optional(),
    battery_soc_percentage: z.number().min(0).max(100).nullable().optional(),
    parking_brake: z.boolean().nullable().optional(),
    error_code: z.number().int().min(0).max(9).nullable().optional(),
    chassis_error_mask: z
      .number()
      .int()
      .min(-2_147_483_648)
      .max(2_147_483_647)
      .nullable()
      .optional(),
  })
  .strict()

export const localizationMessageSchema = z
  .object({
    position: z
      .object({
        x: nullableNumber.optional(),
        y: nullableNumber.optional(),
        z: nullableNumber.optional(),
      })
      .strict()
      .nullable()
      .optional(),
    heading_rad: nullableNumber.optional(),
    frame_id: z.string().max(128).nullable().optional(),
  })
  .strict()

const sampleSchema = <T extends z.ZodTypeAny>(messageSchema: T) =>
  z
    .object({
      age_ms: safeInteger.nullable(),
      source_timestamp_ms: safeInteger.min(1).nullable(),
      source_sequence: safeInteger.max(4_294_967_295).nullable(),
      message: messageSchema.nullable(),
    })
    .strict()

export const vehicleTelemetrySchema = z
  .object({
    schema_version: z.literal(1),
    type: z.literal('vehicle_telemetry'),
    vehicle_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
    stream_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
    sequence: safeInteger.min(1),
    published_at_ms: safeInteger.min(1),
    chassis: sampleSchema(chassisMessageSchema),
    localization: sampleSchema(localizationMessageSchema),
  })
  .strict()

export type VehicleTelemetry = z.infer<typeof vehicleTelemetrySchema>
export type ChassisMessage = z.infer<typeof chassisMessageSchema>
export type LocalizationMessage = z.infer<typeof localizationMessageSchema>

export const vehicleEntrySchema = z
  .object({
    vehicle_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
    name: z.string(),
    state: vehicleTelemetrySchema.nullable(),
    received_at_ms: safeInteger.min(1).nullable(),
    server_time_ms: safeInteger.min(1),
    online: z.boolean(),
    control: z
      .object({
        status: z.enum(['free', 'occupied', 'unknown']),
        is_self: z.boolean(),
      })
      .strict(),
  })
  .strict()
  .superRefine((entry, context) => {
    if (entry.state && entry.state.vehicle_id !== entry.vehicle_id) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Telemetry vehicle_id does not match directory entry',
        path: ['state', 'vehicle_id'],
      })
    }
  })

export type VehicleDirectoryEntry = z.infer<typeof vehicleEntrySchema>

export const vehiclesResponseSchema = z
  .object({ vehicles: z.array(vehicleEntrySchema) })
  .strict()

export type VehiclesResponse = z.infer<typeof vehiclesResponseSchema>

export class VehiclesApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'VehiclesApiError'
  }
}

const gatewayUrl = teleopConfig.gatewayUrl.replace(/\/$/, '')
export const VEHICLES_REQUEST_TIMEOUT_MS = 8_000

async function fetchEntry(path: string, token: string, signal?: AbortSignal): Promise<unknown> {
  const controller = new AbortController()
  let timedOut = false
  const cancel = () => controller.abort()
  signal?.addEventListener('abort', cancel, { once: true })
  if (signal?.aborted) controller.abort()
  const timeout = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, VEHICLES_REQUEST_TIMEOUT_MS)

  try {
    const response = await fetch(`${gatewayUrl}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
      cache: 'no-store',
    })

    if (!response.ok) {
      const details = (await response.text()).trim()
      const message =
        response.status === 401
          ? '车辆目录认证已失效，请重新登录'
          : response.status === 403
            ? '当前账号无权查看授权车辆目录'
            : details || `车辆目录请求失败 (${response.status})`
      throw new VehiclesApiError(message, response.status)
    }

    try {
      return await response.json()
    } catch (error) {
      if (controller.signal.aborted) throw error
      throw new VehiclesApiError('车辆目录服务返回了无效 JSON')
    }
  } catch (error) {
    if (signal?.aborted) throw error
    if (timedOut) throw new VehiclesApiError('车辆目录请求超时，将自动重试')
    if (error instanceof VehiclesApiError) throw error
    throw new VehiclesApiError('无法连接车辆目录服务')
  } finally {
    clearTimeout(timeout)
    signal?.removeEventListener('abort', cancel)
  }
}

export async function fetchVehicles(
  token: string,
  signal?: AbortSignal,
): Promise<VehicleDirectoryEntry[]> {
  const raw = await fetchEntry('/api/vehicles', token, signal)
  const parsed = vehiclesResponseSchema.safeParse(raw)
  if (!parsed.success) throw new VehiclesApiError('车辆目录响应与预期数据格式不符')
  return parsed.data.vehicles
}

export async function fetchVehicle(
  vehicleId: string,
  token: string,
  signal?: AbortSignal,
): Promise<VehicleDirectoryEntry> {
  const raw = await fetchEntry(`/api/vehicles/${encodeURIComponent(vehicleId)}/state`, token, signal)
  const parsed = vehicleEntrySchema.safeParse(raw)
  if (!parsed.success) throw new VehiclesApiError('车辆状态响应与预期数据格式不符')
  return parsed.data
}
