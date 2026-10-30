import { z } from 'zod'
import type { ControlCommand as InputCommand } from '../../../apps/operator-console/src/lib/secure-control-sender'
import { controlCommandSchema, type ControlCommand } from './control-protocol'

export { ControlInput, bindKeyboardInput } from '../../../apps/operator-console/src/lib/control-input'
export { GamepadInput, bindGamepadInput } from '../../../apps/operator-console/src/lib/gamepad-input'
export type { GamepadView } from '../../../apps/operator-console/src/lib/gamepad-input'
import { defaultGamepadMapping } from '../../../apps/operator-console/src/lib/gamepad-input'

export const simulationGamepadMapping = {
  ...defaultGamepadMapping,
  parkButton: -1, neutralButton: -1, driveButton: -1,
  reverseButton: -1, autoEnterButton: -1, autoExitButton: -1,
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
    action: z.enum(['forward', 'reverse', 'left', 'right', 'stop', 'emergency_stop']),
  }).strict(),
]).refine((value) => value.mode !== 'low_level' || !(value.throttle && value.brake), 'Conflicting pedals')

// Reuse input intent, never the legacy v1 sender/session or actuator adapter.
export function simulationCommand(input: InputCommand): ControlCommand {
  const command = inputSchema.parse(input)
  if (command.mode === 'low_level') return controlCommandSchema.parse({
    steering: Math.round(command.steering * 1000), throttle: Math.round(command.throttle * 1000),
    brake: Math.round(command.brake * 1000), direction: command.direction,
  })
  const action = command.action
  return controlCommandSchema.parse({
    steering: action === 'left' ? -1000 : action === 'right' ? 1000 : 0,
    throttle: action === 'forward' || action === 'reverse' ? 1000 : 0,
    brake: action === 'stop' || action === 'emergency_stop' ? 1000 : 0,
    direction: action === 'forward' ? 1 : action === 'reverse' ? -1 : 0,
  })
}
