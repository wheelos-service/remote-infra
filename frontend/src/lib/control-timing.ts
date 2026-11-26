// Base timing primitives; secondary budgets are derived from these primitives
// and can be overridden by Gateway's timing_policy contract within safety clamps.
const BASE_PRIMITIVES = {
  tickMs: 50,
  pauseDropFactor: 6, // 6 * 50ms = 300ms (tolerates 5 consecutive Lossy drops)
  lockFactor: 5, // 5 * 300ms = 1500ms
  mediaPauseGraceMs: 5_000,
  apiTimeoutMs: 3_000,
} as const;

const PAUSE_MS = BASE_PRIMITIVES.tickMs * BASE_PRIMITIVES.pauseDropFactor;
const LOCK_MS = PAUSE_MS * BASE_PRIMITIVES.lockFactor;

export const CONTROL_TIMING = {
  tickMs: BASE_PRIMITIVES.tickMs,
  sendBudgetMs: Math.round(PAUSE_MS * 0.85),
  ackBudgetMs: PAUSE_MS * 2,
  feedbackTimeoutMs: PAUSE_MS * 3 + BASE_PRIMITIVES.tickMs * 2,
  initialFeedbackTimeoutMs: BASE_PRIMITIVES.mediaPauseGraceMs,
  apiTimeoutMs: BASE_PRIMITIVES.apiTimeoutMs,
  rtcConnectTimeoutMs: BASE_PRIMITIVES.mediaPauseGraceMs,
  rtcDisconnectBudgetMs: PAUSE_MS + BASE_PRIMITIVES.tickMs * 4,
  rtcReconnectGraceMs: LOCK_MS - PAUSE_MS,
  handoverTimeoutMs: BASE_PRIMITIVES.mediaPauseGraceMs * 2,
  handoverPollMs: BASE_PRIMITIVES.tickMs * 4,
  pageHiddenGraceMs: BASE_PRIMITIVES.apiTimeoutMs,
  mediaPauseGraceMs: BASE_PRIMITIVES.mediaPauseGraceMs,
  neutralizeBudgetMs: PAUSE_MS + BASE_PRIMITIVES.tickMs * 4,
  controlYieldMs: 10,
  leaseRenewMinMs: 200,
  leaseRenewMaxMs: 30_000,
} as const;

export interface ServerTimingPolicy {
  control_tick_ms?: number;
  watchdog_pause_ms?: number;
  watchdog_lock_ms?: number;
  rtc_reconnect_grace_ms?: number;
  media_pause_grace_ms?: number;
  ack_budget_ms?: number;
  feedback_timeout_ms?: number;
}

export interface ResolvedControlTiming {
  tickMs: number;
  ackBudgetMs: number;
  feedbackTimeoutMs: number;
  rtcReconnectGraceMs: number;
  mediaPauseGraceMs: number;
}

function clampInt(value: number | undefined, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.round(Math.min(max, Math.max(min, value)));
}

export function resolveControlTiming(policy?: ServerTimingPolicy): ResolvedControlTiming {
  const tickMs = clampInt(policy?.control_tick_ms, 20, 100, CONTROL_TIMING.tickMs);
  const pauseMs = clampInt(policy?.watchdog_pause_ms, 150, 1_000, tickMs * BASE_PRIMITIVES.pauseDropFactor);
  const lockMs = clampInt(policy?.watchdog_lock_ms, pauseMs + tickMs, 3_000, pauseMs * BASE_PRIMITIVES.lockFactor);
  const rtcReconnectGraceMs = clampInt(
    policy?.rtc_reconnect_grace_ms,
    pauseMs,
    Math.max(pauseMs, lockMs - tickMs),
    Math.min(CONTROL_TIMING.rtcReconnectGraceMs, Math.max(pauseMs, lockMs - tickMs)),
  );
  const ackBudgetMs = clampInt(policy?.ack_budget_ms, 200, 2_000, CONTROL_TIMING.ackBudgetMs);
  const feedbackTimeoutMs = clampInt(
    policy?.feedback_timeout_ms,
    Math.max(ackBudgetMs, 400),
    3_000,
    CONTROL_TIMING.feedbackTimeoutMs,
  );
  const mediaPauseGraceMs = clampInt(policy?.media_pause_grace_ms, 1_000, 10_000, CONTROL_TIMING.mediaPauseGraceMs);
  return { tickMs, ackBudgetMs, feedbackTimeoutMs, rtcReconnectGraceMs, mediaPauseGraceMs };
}
