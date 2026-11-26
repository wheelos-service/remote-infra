import { CONTROL_TIMING } from './control-timing'

export type ControlSafetyEvent =
  | 'window_blur'
  | 'window_focus'
  | 'page_hidden'
  | 'page_visible'
  | 'page_unload'
  | 'editable_focus'
  | 'input_unavailable'
  | 'media_lost'
  | 'rtc_disconnected'
  | 'rtc_reconnecting'
  | 'rtc_reconnected'
  | 'feedback_timeout'
  | 'control_fault'

export type ControlSafetyStrategy = 'disarm' | 'observe' | 'release' | 'fault'
export type ControlRecovery = 'manual-rearm' | 'continue-observing' | 'new-session'
export type ControlSafetyDecision = {
  strategy: ControlSafetyStrategy
  message: string
  recovery: ControlRecovery
  retainSession: boolean
  escalateAfterMs?: number
  escalateTo?: ControlSafetyEvent
}

const CONTROL_SAFETY_DECISIONS: Readonly<Record<ControlSafetyEvent, ControlSafetyDecision>> = {
  window_blur: { strategy: 'disarm', message: '窗口失焦：已停止，请重新启用控制', recovery: 'manual-rearm', retainSession: true },
  window_focus: { strategy: 'observe', message: '窗口恢复；控制仍保持停用', recovery: 'manual-rearm', retainSession: true },
  page_hidden: {
    strategy: 'disarm', message: '页面隐藏：已停止，短时保留控制会话', recovery: 'manual-rearm', retainSession: true,
    escalateAfterMs: CONTROL_TIMING.pageHiddenGraceMs, escalateTo: 'page_unload',
  },
  page_visible: { strategy: 'observe', message: '页面可见；控制仍保持停用', recovery: 'manual-rearm', retainSession: true },
  page_unload: { strategy: 'release', message: '页面离开：输入已停止并释放控制权', recovery: 'new-session', retainSession: false },
  editable_focus: { strategy: 'disarm', message: '输入区域获得焦点：驾驶按键已停用', recovery: 'manual-rearm', retainSession: true },
  input_unavailable: { strategy: 'disarm', message: '输入不可用：已停止，请检查设备状态', recovery: 'manual-rearm', retainSession: true },
  media_lost: { strategy: 'fault', message: 'Camera feed lost; release and acquire a new session', recovery: 'new-session', retainSession: false },
  rtc_disconnected: { strategy: 'fault', message: 'RTC disconnected; release before switching', recovery: 'new-session', retainSession: false },
  rtc_reconnecting: { strategy: 'disarm', message: 'RTC 重连中：已停止输入，恢复后请手动重新启用', recovery: 'manual-rearm', retainSession: true },
  rtc_reconnected: { strategy: 'observe', message: 'RTC 已重连；控制仍保持停用，请手动重新启用', recovery: 'manual-rearm', retainSession: true },
  feedback_timeout: { strategy: 'fault', message: 'Control lease or vehicle feedback timed out', recovery: 'new-session', retainSession: false },
  control_fault: { strategy: 'fault', message: 'Control interrupted by a safety fault', recovery: 'new-session', retainSession: false },
}

export function controlSafetyDecision(event: ControlSafetyEvent): ControlSafetyDecision {
  return CONTROL_SAFETY_DECISIONS[event]
}

export type ControlSafetyActions = {
  disarm(event: ControlSafetyEvent, decision: ControlSafetyDecision): void
  observe(event: ControlSafetyEvent, decision: ControlSafetyDecision): void
  release(event: ControlSafetyEvent, decision: ControlSafetyDecision): void
  fault(event: ControlSafetyEvent, decision: ControlSafetyDecision): void
}

export function applyControlSafetyStrategy(event: ControlSafetyEvent, actions: ControlSafetyActions): void {
  const decision = controlSafetyDecision(event)
  actions[decision.strategy](event, decision)
}
