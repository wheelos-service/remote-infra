import { z } from 'zod'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
const integer = z.number().int().safe()
const gear = z.enum(['D', 'N', 'R'])
export type Gear = z.infer<typeof gear>
export const controlCommandSchema = z.object({
  steering: integer.min(-100).max(100),
  throttle: integer.min(0).max(100),
  brake: integer.min(0).max(100),
  direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  gear_request: gear.optional(),
  service_brake: z.literal(true).optional(),
}).strict().refine(c => !c.gear_request || (c.steering === 0 && c.direction === 0 && c.throttle === 0 && c.brake === 20 && !c.service_brake), 'Invalid shift request')
  .refine(c => !c.service_brake || (c.direction === 0 && c.brake > 0), 'Invalid service brake')
  .refine((value) => !(value.throttle && value.brake), 'Conflicting pedals')
export type ControlCommand = z.infer<typeof controlCommandSchema>
export const neutralCommand: ControlCommand = { steering: 0, throttle: 0, brake: 0, direction: 0 }

export const controlFeedbackSchema = z.object({
  version: z.literal(2),
  type: z.literal('control.feedback'),
  vehicle_id: id,
  session_id: id.or(z.literal('')),
  receiver_instance_id: z.string().regex(/^[a-f0-9]{32}$/),
  revision: integer.nonnegative(),
  accepted_sequence: integer.nonnegative(),
  status: z.enum(['DISABLED', 'READY', 'ACCEPTED', 'APPLIED', 'PAUSED', 'LOCKED']),
  reason: z.string().max(64),
  last_rejection: z.string().max(64),
  simulation: z.boolean().optional(),
  command: controlCommandSchema.nullable(),
}).strict()
export type ControlFeedback = z.infer<typeof controlFeedbackSchema>

export const controlPayloadSchema = z.object({
  version: z.literal(2),
  type: z.literal('control'),
  vehicle_id: id,
  session_id: id,
  client_instance_id: id,
  receiver_instance_id: z.string().regex(/^[a-f0-9]{32}$/),
  revision: integer.positive(),
  sequence: integer.positive(),
  timestamp_ms: integer.positive(),
  command: controlCommandSchema,
}).strict()
export type ControlPayload = z.infer<typeof controlPayloadSchema>

export function controlSignBytes(input: ControlPayload): Uint8Array {
  const p = controlPayloadSchema.parse(input)
  return new TextEncoder().encode(JSON.stringify([
    p.version, p.type, p.vehicle_id, p.session_id, p.client_instance_id,
    p.receiver_instance_id, p.revision, p.sequence, p.timestamp_ms,
    p.command.steering, p.command.throttle, p.command.brake, p.command.direction,
    ...(p.command.gear_request ? [p.command.gear_request] : []),
    ...(p.command.service_brake ? [true] : []),
  ]))
}

export function base64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
}

export async function signControl(key: CryptoKey, payload: ControlPayload): Promise<string> {
  const message = controlSignBytes(payload)
  const signature = await crypto.subtle.sign('Ed25519', key, message as BufferSource)
  return JSON.stringify({ ...payload, signature: base64(new Uint8Array(signature)) })
}
