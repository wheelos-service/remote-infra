import { z } from 'zod'

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
const integer = z.number().int().safe()
export const controlCommandSchema = z.object({
  steering: integer.min(-1000).max(1000),
  throttle: integer.min(0).max(1000),
  brake: integer.min(0).max(1000),
  direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
}).strict().refine((value) => !(value.throttle && value.brake), 'Conflicting pedals')
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
  status: z.enum(['DISABLED', 'READY', 'APPLIED', 'LOCKED']),
  reason: z.string().max(64),
  last_rejection: z.string().max(64),
  simulation: z.literal(true),
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
