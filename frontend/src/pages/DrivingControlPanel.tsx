import React, { useCallback, useEffect, useRef, useState } from 'react'
import { DataPacket_Kind, Room, RoomEvent } from 'livekit-client'
import { teleopConfig } from '../lib/teleop-config'
import { ControlSessionClient, isControlReady, steeringAlignedHold } from '../lib/control-session-client'
import { applyControlSafetyStrategy, type ControlSafetyEvent } from '../lib/control-safety'
import { CONTROL_TIMING } from '../lib/control-timing'
import type { ControlCommand } from '../lib/control-protocol'
import type { TeleopDiagnosticsBuffer } from '../lib/teleop-diagnostics'
import {
  ControlInput, GamepadInput, bindGamepadInput, bindKeyboardInput,
  toV2ControlCommand, v2GamepadMapping, type GamepadView, type GamepadMapping,
} from '../lib/control-input-adapter'

function withinBudget(promise: Promise<void>, message: string): Promise<void> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(message)), CONTROL_TIMING.neutralizeBudgetMs)),
  ])
}

export function DrivingControlPanel({ vehicleId, bearer, videoReady, verifyVideo, receiverReady = true, requestBlocker, onBusyChange, onIntent, diagnostics }: {
  vehicleId: string
  bearer: string
  requestBlocker?: string
  receiverReady?: boolean
  verifyVideo?: () => boolean
  videoReady: boolean
  onBusyChange: (busy: boolean) => void
  onIntent: (vehicleId: string, command?: ControlCommand) => void
  diagnostics?: TeleopDiagnosticsBuffer
}) {
  const controller = useRef<ControlSessionClient | undefined>(undefined)
  const input = useRef<ControlInput | undefined>(undefined)
  const gamepad = useRef<GamepadInput | undefined>(undefined)
  const mounted = useRef(false)
  const mediaReady = useRef(videoReady)
  const safetyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const mediaPauseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const hiddenAt = useRef<number | undefined>(undefined)
  const autoReleasedFor = useRef<ControlSessionClient | undefined>(undefined)
  mediaReady.current = videoReady
  const [, render] = useState(0)
  const [message, setMessage] = useState('')
  const [faultNotice, setFaultNotice] = useState('')
  const [mediaPaused, setMediaPaused] = useState(false)
  const [vehicleArbitration, setVehicleArbitration] = useState<{
    state?: string; safetyOverride?: string; errorCode?: string; reason?: string; drivingMode?: string; speedMps?: number; steeringPct?: number
  }>()
  const [inputState, setInputState] = useState({ gamepadEnabled: false, message: '输入未启用' })
  const [pad, setPad] = useState<GamepadView>()
  const [mapping, setMapping] = useState<GamepadMapping>({ ...v2GamepadMapping })
  const clearSafetyTimer = useCallback(() => {
    if (safetyTimer.current) clearTimeout(safetyTimer.current)
    safetyTimer.current = undefined
  }, [])
  const clearMediaPauseTimer = useCallback(() => {
    if (mediaPauseTimer.current) clearTimeout(mediaPauseTimer.current)
    mediaPauseTimer.current = undefined
  }, [])
  const releaseSession = useCallback(async (active: ControlSessionClient | undefined = controller.current) => {
    clearMediaPauseTimer()
    setMediaPaused(false)
    const drained = input.current?.suspendAndWait('正在释放控制权') ?? Promise.resolve()
    await withinBudget(drained, 'Input neutralization timed out').catch(() => undefined)
    let failure: unknown
    try {
      if (active) await withinBudget(active.neutralizeAndPublish(CONTROL_TIMING.neutralizeBudgetMs),
        'Safe publication timed out')
    }
    catch (error) { failure = error }
    try { await active?.release() }
    catch (error) { failure ??= error }
    if (failure && mounted.current) setMessage(failure instanceof Error ? failure.message : 'Handover pending')
  }, [clearMediaPauseTimer])
  const applySafetyEvent = useCallback((event: ControlSafetyEvent,
      active: ControlSessionClient | undefined = controller.current): void => {
    applyControlSafetyStrategy(event, {
      disarm: (safetyEvent, decision) => {
        input.current?.suspend(decision.message)
        if (safetyEvent === 'page_hidden') hiddenAt.current = Date.now()
        if (decision.escalateAfterMs && decision.escalateTo) {
          clearSafetyTimer()
          const escalation = decision.escalateTo
          safetyTimer.current = setTimeout(() => {
            safetyTimer.current = undefined
            if (safetyEvent === 'page_hidden' && !document.hidden) return
            applySafetyEvent(escalation, active)
          }, decision.escalateAfterMs)
        }
      },
      observe: (safetyEvent, decision) => {
        if (safetyEvent === 'rtc_reconnected') {
          if (decision.message) input.current?.suspend(decision.message)
          return
        }
        const restored = safetyEvent === 'page_visible' || (safetyEvent === 'window_focus' && !document.hidden)
        if (!restored) return
        const expired = hiddenAt.current !== undefined &&
          Date.now() - hiddenAt.current >= CONTROL_TIMING.pageHiddenGraceMs
        hiddenAt.current = undefined
        clearSafetyTimer()
        if (expired) {
          applySafetyEvent('page_unload', active)
          return
        }
        if (decision.message) input.current?.suspend(decision.message)
      },
      release: (_safetyEvent, decision) => {
        hiddenAt.current = undefined
        clearSafetyTimer()
        clearMediaPauseTimer()
        setMediaPaused(false)
        if (!active) {
          input.current?.suspend(decision.message)
          return
        }
        void (async () => {
          const drained = input.current?.suspendAndWait(decision.message) ?? Promise.resolve()
          await withinBudget(drained, 'Input neutralization timed out').catch(() => undefined)
          let neutralizeError: unknown
          try { await withinBudget(active.neutralizeAndPublish(CONTROL_TIMING.neutralizeBudgetMs), 'Safe publication timed out') }
          catch (error) { neutralizeError = error }
          try { await active.release() }
          catch (error) { throw neutralizeError ?? error }
          if (neutralizeError) throw neutralizeError
        })().catch(() => {
          if (mounted.current) render((n) => n + 1)
          else console.error('控制释放未确认；需检查 Gateway 交接状态')
        })
      },
      fault: (_safetyEvent, decision) => {
        hiddenAt.current = undefined
        clearSafetyTimer()
        clearMediaPauseTimer()
        setMediaPaused(false)
        input.current?.suspend(decision.message)
        active?.fail(decision.message)
      },
    })
  }, [clearSafetyTimer, clearMediaPauseTimer])
  const triggerEmergencyStop = useCallback(() => {
    const active = controller.current
    if (!active || active.state !== 'ready') return
    if (input.current?.isAvailable) {
      input.current.emergencyStop()
      return
    }
    const emergency: ControlCommand = { steering: 0, throttle: 0, brake: 100, direction: 0 }
    input.current?.suspend('已触发紧急制动')
    try {
      active.setCommand(emergency)
      onIntent(vehicleId, emergency)
      void active.tick()
    } catch {
      // If session is already locked/closed, no further command can be dispatched.
    }
  }, [onIntent, vehicleId])
  const changed = useCallback(() => {
    if (!mounted.current) return
    const active = controller.current
    const state = active?.state
    const ready = isControlReady(state, mediaReady.current) && Boolean(active?.neutralAcknowledged)
    if (input.current?.isAvailable !== ready) input.current?.setAvailable(ready)
    if (!ready) onIntent(vehicleId)
    if (active && state === 'locked' && autoReleasedFor.current !== active) {
      autoReleasedFor.current = active
      const reason = active.error || '控制已中断'
      setFaultNotice(`已停止发令，正在释放控制权：${reason}`)
      void releaseSession(active)
    }
    onBusyChange(Boolean(state && state !== 'closed' && state !== 'idle'))
    render((n) => n + 1)
  }, [onBusyChange, onIntent, releaseSession, vehicleId])

  useEffect(() => {
    mounted.current = true
    const controls = new ControlInput({
      allowVehicleActions: false,
      send: async (intent) => {
        const active = controller.current
        if (!active || !isControlReady(active.state, mediaReady.current)) throw new Error('控制或三路画面尚未就绪')
        const command = toV2ControlCommand(intent)
        active.setCommand(command)
        onIntent(vehicleId, command)
        await active.tick()
      },
      onChange: ({ gamepadEnabled, message }) => {
        if (mounted.current) setInputState({ gamepadEnabled, message })
      },
      onError: (error) => {
        controller.current?.fail(error instanceof Error ? error.message : '输入处理失败')
      },
    })
    const monitor = new GamepadInput(controls, (value) => { if (mounted.current) setPad(value) })
    monitor.setMapping(v2GamepadMapping)
    setMapping({ ...v2GamepadMapping })
    input.current = controls
    gamepad.current = monitor
    const unbindKeyboard = bindKeyboardInput(controls, window, document, undefined, undefined, applySafetyEvent, triggerEmergencyStop)
    const unbindGamepad = bindGamepadInput(monitor, window, document, navigator)
    const pagehide = (event: PageTransitionEvent) => applySafetyEvent(event.persisted ? 'page_hidden' : 'page_unload')
    window.addEventListener('pagehide', pagehide)
    return () => {
      mounted.current = false
      unbindGamepad()
      unbindKeyboard()
      window.removeEventListener('pagehide', pagehide)
      clearSafetyTimer()
      clearMediaPauseTimer()
      applySafetyEvent('page_unload')
      onIntent(vehicleId)
    }
  }, [bearer, vehicleId, onIntent, applySafetyEvent, clearSafetyTimer, clearMediaPauseTimer, triggerEmergencyStop])

  useEffect(() => {
    const active = controller.current
    if (videoReady) {
      if (mediaPauseTimer.current) diagnostics?.record('video', 'media_pause_recovered')
      clearMediaPauseTimer()
      setMediaPaused(false)
      active?.setMediaReady(true)
      changed()
      return
    }
    if (!active || active.state !== 'ready') {
      clearMediaPauseTimer()
      setMediaPaused(false)
      active?.setMediaReady(false)
      changed()
      return
    }
    // L1 pause grace: immediately stop user inputs and hold gentle service brake
    // (only when already REMOTE and not emergency-braking) up to server contract
    // mediaPauseGraceMs while video recovers, before escalating to auto-release.
    if (!mediaPauseTimer.current) {
      const { outcome, command } = active.selectVideoPauseCommand()
      diagnostics?.record('video', 'media_pause_hold', outcome)
      setMediaPaused(true)
      if (outcome !== 'emergency_stop') {
        onIntent(vehicleId, command)
        void active.tick()
      }
      mediaPauseTimer.current = setTimeout(() => {
        mediaPauseTimer.current = undefined
        if (!mediaReady.current && controller.current === active && active.state === 'ready') {
          setMediaPaused(false)
          active.setMediaReady(false)
          changed()
        }
      }, active.timingPolicy.mediaPauseGraceMs)
    }
    changed()
  }, [videoReady, changed, clearMediaPauseTimer, diagnostics, onIntent, vehicleId])

  const acquire = async () => {
    if (!mediaReady.current) return
    if (controller.current && !['idle', 'closed'].includes(controller.current.state)) return
    if (!globalThis.crypto?.subtle || typeof crypto.randomUUID !== 'function') {
      setMessage('控制签名要求 HTTPS 或 localhost，以及支持 Ed25519 的浏览器；不会降级到旧协议。')
      return
    }
    setMessage('')
    setFaultNotice('')
    autoReleasedFor.current = undefined
    clearMediaPauseTimer()
    setMediaPaused(false)
    setVehicleArbitration(undefined)
    // On the pinned SFU a data-only controller needs a publisher transport.
    const room = new Room({ adaptiveStream: false, dynacast: false, singlePeerConnection: false })
    const next = new ControlSessionClient(vehicleId, teleopConfig.gatewayUrl, bearer, {
      connect: async token => {
        await room.connect(teleopConfig.livekitUrl, token, { autoSubscribe: false })
        // Negotiate SCTP before starting the signed-command ACK deadline.
        await room.localParticipant.publishData(new Uint8Array(), {reliable: false, topic: 'vehicle.control.transport-ready',
          destinationIdentities: [`vehicle-${vehicleId}`]})
      },
      publish: async (body) => {
        await room.localParticipant.publishData(new Uint8Array(body), { reliable: false, topic: 'vehicle.control.v2',
          destinationIdentities: [`vehicle-${vehicleId}`] })
      },
      disconnect: async () => { await room.disconnect() },
    }, changed, undefined, verifyVideo)
    next.setMediaReady(mediaReady.current)
    controller.current = next
    room.on(RoomEvent.DataReceived, (body, participant, kind, topic) => {
      if (topic === 'vehicle.control.feedback.v2') {
        next.acceptFeedback(participant?.identity ?? '', kind === DataPacket_Kind.RELIABLE, body)
        return
      }
      if (topic === 'vehicle.state' && participant?.identity === `vehicle-${vehicleId}` &&
          kind === DataPacket_Kind.RELIABLE && body.length <= 16384 && mounted.current && controller.current === next) {
        try {
          const parsed = JSON.parse(new TextDecoder().decode(body)) as {
            type?: string
            sources_omitted?: boolean
            telemetry?: { chassis?: { message?: { driving_mode?: string; speed_mps?: number; steering_percentage?: number } } }
            sources?: { vehicle_status?: { message?: { state?: string; safety_override?: string; error_code?: string; reason?: string } } }
          }
          if (parsed?.type !== 'vehicle.state') return
          const status = parsed.sources?.vehicle_status?.message
          const chassis = parsed.telemetry?.chassis?.message
          next.updateArbitration(status?.state, chassis?.driving_mode, chassis?.steering_percentage)
          const preserveStatus = Boolean(parsed.sources_omitted && !status)
          if (parsed.sources_omitted) diagnostics?.record('feedback', 'vehicle_state_sources_omitted', status ? 'kept_status' : 'omitted_all')
          setVehicleArbitration(previous => ({
            state: typeof status?.state === 'string' ? status.state : (preserveStatus ? previous?.state : undefined),
            safetyOverride: typeof status?.safety_override === 'string' ? status.safety_override : (preserveStatus ? previous?.safetyOverride : undefined),
            errorCode: typeof status?.error_code === 'string' ? status.error_code : (preserveStatus ? previous?.errorCode : undefined),
            reason: typeof status?.reason === 'string' ? status.reason : (preserveStatus ? previous?.reason : undefined),
            drivingMode: typeof chassis?.driving_mode === 'string' ? chassis.driving_mode : undefined,
            speedMps: typeof chassis?.speed_mps === 'number' ? chassis.speed_mps : undefined,
            steeringPct: typeof chassis?.steering_percentage === 'number' ? chassis.steering_percentage : undefined,
          }))
        } catch {
          // Ignore malformed optional telemetry envelopes; feedback remains authoritative.
        }
      }
    })
    room.on(RoomEvent.Disconnected, () => {
      if (!['releasing', 'pending', 'closed'].includes(next.state)) applySafetyEvent('rtc_disconnected', next)
    })
    room.on(RoomEvent.Reconnecting, () => {
      next.setRtcReconnecting(true)
      applySafetyEvent('rtc_reconnecting', next)
    })
    room.on(RoomEvent.Reconnected, () => {
      next.setRtcReconnecting(false)
      applySafetyEvent('rtc_reconnected', next)
    })
    try { await next.acquire() } catch (error) {
      if (mounted.current) setMessage(error instanceof Error ? error.message : 'Control acquire failed')
    }
  }
  const release = () => releaseSession()
  const downloadDiagnostics = () => {
    const active = controller.current
    if (!active && !diagnostics) return
    const blob = new Blob([JSON.stringify({
      protocol_version: 2, vehicle_id: vehicleId, clock_domain: 'browser-performance',
      time_origin_ms: performance.timeOrigin,
      events: active?.diagnostics ?? [],
      camera_windows: diagnostics?.videoWindows ?? [],
      timeline_events: diagnostics?.entries() ?? [],
    }, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = 'teleop-diagnostics.json'
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 0)
  }
  const requestTakeover = () => {
    const active = controller.current
    if (!active || !isControlReady(active.state, mediaReady.current)) return
    const command = steeringAlignedHold(vehicleArbitration?.steeringPct)
    active.setCommand(command)
    onIntent(vehicleId, command)
    void active.tick()
  }
  const state = controller.current?.state ?? 'idle'
  const ready = isControlReady(state, videoReady) && Boolean(controller.current?.neutralAcknowledged)
  const busy = state !== 'closed' && state !== 'idle'
  const button = 'rounded border border-amber-600 px-3 py-2 disabled:opacity-40'
  return (
    <section className="rounded-xl border border-amber-700 bg-amber-950/20 p-3 text-xs text-amber-100">
      <p className="font-semibold">远程驾驶控制</p>
      <p className="mt-1">目标：{vehicleId || '未选择'} · 状态：{state}</p>
      {!busy && requestBlocker && <p role="status">{requestBlocker}</p>}
      {verifyVideo && <p>{receiverReady ? '车端 native-v3 接收器在线' : '等待车端 native-v3 接收器心跳'}
        {state === 'ready' && !controller.current?.neutralAcknowledged && ' · 正在验证中立指令回执'}</p>}
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={!vehicleId || busy || !videoReady || !receiverReady || Boolean(requestBlocker)} onClick={() => void acquire()} className={button}>申请控制权</button>
        <button type="button" disabled={!ready || vehicleArbitration?.state === 'REMOTE'} onClick={requestTakeover} className={button}>
          {vehicleArbitration?.state === 'REMOTE' ? '车端已接管 REMOTE' : '请求接管（制动保持）'}
        </button>
        <button type="button" disabled={!busy} onClick={() => void release()} className={button}>释放并等待车辆交接</button>
      </div>
      <details className="mt-3">
        <summary>手柄检测与映射（修改后需重新确认，-1 表示不用）</summary>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {([
            ['axisX', '转向轴'], ['axisY', '前后轴'], ['enableButton', '使能按钮'],
            ['emergencyButton', '制动按钮'], ['upButton', '前进按钮'], ['downButton', '倒车按钮'],
            ['leftButton', '左转按钮'], ['rightButton', '右转按钮'],
          ] as const).map(([key, label]) => <label key={key} className="flex items-center justify-between gap-2">
            {label}<input type="number" aria-label={`手柄${label}编号`} value={mapping[key]} min={key === 'enableButton' || key === 'emergencyButton' ? 0 : -1}
              className="w-20 rounded border border-amber-800 bg-slate-950 p-2"
              onChange={event => {
                const value = { ...mapping, [key]: event.currentTarget.valueAsNumber }
                setMapping(value)
                gamepad.current?.setMapping(value)
              }} />
          </label>)}
          {(['invertX', 'invertY'] as const).map((key, index) => <label key={key}>
            <input type="checkbox" checked={mapping[key]} onChange={event => {
              const value = { ...mapping, [key]: event.currentTarget.checked }
              setMapping(value)
              gamepad.current?.setMapping(value)
            }} /> {index === 0 ? '反转转向轴' : '反转前后轴'}
          </label>)}
        </div>
      </details>
      <p className="mt-2">{videoReady
        ? '三路画面正在出帧'
        : mediaPaused
          ? '画面短暂中断：驾驶输入已停用（恢复后需手动重新启用手柄）'
          : '三路画面未就绪：禁止申请或恢复输出'}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select aria-label="控制手柄" className="rounded border border-amber-800 bg-slate-950 p-2"
          value={pad?.selectedIndex ?? ''} disabled={!ready} onChange={(event) => {
            gamepad.current?.select(event.target.value === '' ? null : Number(event.target.value))
            event.currentTarget.blur()
          }}>
          <option value="">选择手柄</option>
          {pad?.devices.map((device) => <option key={device.index} value={device.index}>{device.id}</option>)}
        </select>
        <button type="button" className={button} disabled={!ready || !pad?.pad || Boolean(pad.validation)}
          onClick={() => gamepad.current?.confirmMapping(!pad?.confirmed)}>{pad?.confirmed ? '撤销映射确认' : '确认标准映射'}</button>
        <button type="button" className={button} disabled={!ready || !pad?.canEnable}
          onClick={() => gamepad.current?.setEnabled(!inputState.gamepadEnabled)}>{inputState.gamepadEnabled ? '关闭手柄' : '启用手柄'}</button>
        <span>左摇杆 X 转向 / 右摇杆 Y 前后 · LB 按住使能 · B 制动；先松键回中</span>
      </div>
      <p className="mt-2">{inputState.message} · {pad?.validation || pad?.message}</p>
      {pad?.pad && <p className="mt-1">轴：{pad.pad.axes.map((value) => value.toFixed(2)).join(' / ')} · 按下按钮：{pad.pad.buttons.flatMap((value, index) => value.pressed ? [index] : []).join(', ') || '无'}</p>}
      <p className="mt-2">挡位和自动驾驶模式请求未接入 v2，不开放对应手柄动作；不回退到 v1。</p>
      <p className="mt-2">仅开放手柄比例控制，不支持键盘驾驶；前三相机无后视覆盖，倒车前需确认后方环境。</p>
      <p className="mt-2">反馈序号：{controller.current?.feedback?.accepted_sequence ?? '—'}；
        {controller.current?.feedback?.reason ?? '等待本次会话反馈'}。反馈表示车端接收状态，底盘执行以车辆实测为准。失焦、断线或反馈超时停止发令；交接完成前禁止切换。</p>
      {vehicleArbitration && (vehicleArbitration.state || vehicleArbitration.drivingMode) && (
        <p className="mt-1 text-amber-200" data-testid="vehicle-arbitration-status">
          车端仲裁：{vehicleArbitration.state ?? '未知'}
          {vehicleArbitration.safetyOverride ? ` · 覆盖：${vehicleArbitration.safetyOverride}` : ''}
          {vehicleArbitration.drivingMode ? ` · 底盘模式：${vehicleArbitration.drivingMode}` : ''}
          {typeof vehicleArbitration.speedMps === 'number' ? ` · 车速：${vehicleArbitration.speedMps.toFixed(2)} m/s` : ''}
          {vehicleArbitration.errorCode && vehicleArbitration.errorCode !== 'ERROR_NONE' ? ` · 错误：${vehicleArbitration.errorCode}` : ''}
          {vehicleArbitration.reason ? `（${vehicleArbitration.reason}）` : ''}
        </p>
      )}
      <p className="mt-1">纵向配置：{teleopConfig.controlLongitudinalMode === 'speed' ? `速度模式（上限 ${(teleopConfig.maxRemoteSpeedMps ?? 5).toFixed(1)} m/s，以车端 device.json 为准）` : '油门模式（0–100%，以车端 device.json 为准）'}</p>
      <p data-testid="control-feedback" data-sequence={controller.current?.feedback?.accepted_sequence}
        data-command={JSON.stringify(controller.current?.feedback?.command)} className="mt-2">
        指令设定（非底盘实测）：
        {controller.current?.feedback?.command
          ? `转向 ${controller.current.feedback.command.steering}% · ${
            teleopConfig.controlLongitudinalMode === 'speed'
              ? `速度 ${controller.current.feedback.command.throttle}% (${((controller.current.feedback.command.throttle / 100) * (teleopConfig.maxRemoteSpeedMps ?? 5)).toFixed(2)} m/s)`
              : `油门 ${controller.current.feedback.command.throttle}%`
          } · 制动 ${controller.current.feedback.command.brake}% · 方向 ${controller.current.feedback.command.direction}`
          : '等待反馈'}
      </p>
      {(faultNotice || message || controller.current?.error) && (
        <p role="alert" className="mt-2 text-red-300">{faultNotice || controller.current?.error || message}</p>
      )}
      {controller.current?.cleanupError && <p role="alert" className="mt-2 text-red-300">交接清理：{controller.current.cleanupError}</p>}
      <button type="button" className={`${button} mt-2`} disabled={!controller.current && !diagnostics}
        onClick={downloadDiagnostics}>导出近期遥操作诊断</button>
      <div className="fixed inset-x-0 bottom-0 z-[60] flex flex-wrap items-center justify-end gap-3 border-t border-amber-800 bg-slate-950 p-3 text-xs">
        <span>{vehicleId} · {state} · {inputState.gamepadEnabled ? '手柄已启用' : '手柄未启用'}</span>
        <button type="button" disabled={!ready} className={button} onClick={() => {
          input.current?.suspend('已发送停止，请重新启用手柄')
        }}>停止并停用手柄</button>
        <button type="button" disabled={state !== 'ready'} className="rounded border border-red-500 bg-red-950 px-4 py-2 disabled:opacity-40" onClick={triggerEmergencyStop}>制动（Space）</button>
      </div>
    </section>
  )
}
