// Sample intent, network progress and handover are separate clocks.
// Safety budgets are independent of display or device polling cadence.
export const CONTROL_TIMING = {
  tickMs: 75,
  sendBudgetMs: 250,
  ackBudgetMs: 600,
  feedbackTimeoutMs: 1_000,
  initialFeedbackTimeoutMs: 5_000,
  apiTimeoutMs: 3_000,
  rtcConnectTimeoutMs: 5_000,
  rtcDisconnectBudgetMs: 500,
  handoverTimeoutMs: 10_000,
  handoverPollMs: 200,
  pageHiddenGraceMs: 3_000,
  neutralizeBudgetMs: 500,
  controlYieldMs: 10,
  leaseRenewMinMs: 200,
  leaseRenewMaxMs: 30_000,
} as const;
