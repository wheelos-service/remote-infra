// Poll devices near display refresh rate; repeat intents at the lower transport-neutral cadence.
export const TELEOP_TIMING = {
    gamepadPollMs: 16,
    inputRepeatMs: 100,
    gamepadSampleTimeoutMs: 300,
} as const;
