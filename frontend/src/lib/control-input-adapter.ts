import { z } from 'zod'
import type { ControlCommand as InputCommand } from '@livekit-infra/teleop-shared/input-command'
import { controlCommandSchema, type ControlCommand } from './control-protocol'

export { ControlInput, bindKeyboardInput } from '@livekit-infra/teleop-shared/control-input'
export { GamepadInput, bindGamepadInput } from '@livekit-infra/teleop-shared/gamepad-input'
export type { GamepadView, GamepadMapping } from '@livekit-infra/teleop-shared/gamepad-input'
import { defaultGamepadMapping } from '@livekit-infra/teleop-shared/gamepad-input'

export const v2GamepadMapping = {
  ...defaultGamepadMapping,
  parkButton: -1, autoEnterButton: -1, autoExitButton: -1,
}
const normalized = z.number().finite().min(-1).max(1)
const inputSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('low_level'), steering: normalized,
    throttle: normalized.min(0), brake: normalized.min(0),
    direction: z.union([z.literal(-1), z.literal(0), z.literal(1)]),
  }).strict(),
  z.object({
    mode: z.literal('high_level'),
    action: z.enum(['forward', 'reverse', 'left', 'right', 'stop', 'emergency_stop', 'gear_drive', 'gear_neutral', 'gear_reverse']),
  }).strict(),
]).refine((value) => value.mode !== 'low_level' || !(value.throttle && value.brake), 'Conflicting pedals')

// Reuse input intent, never the legacy v1 sender/session or actuator adapter.
export function toV2ControlCommand(input: InputCommand): ControlCommand {
  const command = inputSchema.parse(input)
  if (command.mode === 'low_level') return controlCommandSchema.parse({
    steering: Math.round(command.steering * 100), throttle: Math.round(command.throttle * 100),
    brake: Math.round(command.brake * 100), direction: command.direction,
    ...(Math.round(command.brake * 100) > 0 ? { service_brake: true } : {}),
  })
  const action = command.action
  if (action === 'gear_drive' || action === 'gear_neutral' || action === 'gear_reverse') {
    return { steering: 0, throttle: 0, brake: 20, direction: 0,
      gear_request: ({ gear_drive: 'D', gear_neutral: 'N', gear_reverse: 'R' } as const)[action] }
  }
  return controlCommandSchema.parse({
    steering: action === 'left' ? -100 : action === 'right' ? 100 : 0,
    throttle: action === 'forward' || action === 'reverse' ? 100 : 0,
    brake: action === 'emergency_stop' ? 100 : 0,
    direction: action === 'forward' ? 1 : action === 'reverse' ? -1 : 0,
  })
}
