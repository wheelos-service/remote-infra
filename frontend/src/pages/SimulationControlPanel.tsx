import React, { useCallback, useEffect, useRef, useState } from 'react'
import { DataPacket_Kind, Room, RoomEvent } from 'livekit-client'
import { teleopConfig } from '../lib/teleop-config'
import { ControlSessionClient } from '../lib/control-session-client'
import type { ControlCommand } from '../lib/control-protocol'
import {
  ControlInput, GamepadInput, bindGamepadInput, bindKeyboardInput,
  toV2ControlCommand, v2GamepadMapping, type GamepadView, type GamepadMapping,
} from '../lib/control-input-adapter'

export function SimulationControlPanel({ vehicleId, bearer, videoReady, onBusyChange, onIntent }: {
  vehicleId: string
  bearer: string
  videoReady: boolean
  onBusyChange: (busy: boolean) => void
  onIntent: (vehicleId: string, command?: ControlCommand) => void
}) {
  const controller = useRef<ControlSessionClient | undefined>(undefined)
  const input = useRef<ControlInput | undefined>(undefined)
  const gamepad = useRef<GamepadInput | undefined>(undefined)
  const mounted = useRef(false)
  const mediaReady = useRef(videoReady)
  mediaReady.current = videoReady
  const [, render] = useState(0)
  const [message, setMessage] = useState('')
  const [inputState, setInputState] = useState({ keyboardEnabled: false, gamepadEnabled: false, message: '输入未启用' })
  const [pad, setPad] = useState<GamepadView>()
  const [mapping, setMapping] = useState<GamepadMapping>({ ...v2GamepadMapping })
  const changed = useCallback(() => {
    if (!mounted.current) return
    const state = controller.current?.state
    const ready = state === 'ready' && mediaReady.current
    if (input.current?.isAvailable !== ready) input.current?.setAvailable(ready)
    if (!ready) onIntent(vehicleId)
    onBusyChange(Boolean(state && state !== 'closed' && state !== 'idle'))
    render((n) => n + 1)
  }, [onBusyChange, onIntent, vehicleId])

  useEffect(() => {
    mounted.current = true
    const controls = new ControlInput({
      allowVehicleActions: false,
      send: async (intent) => {
        const active = controller.current
        if (active?.state !== 'ready' || !mediaReady.current) throw new Error('模拟控制或三路画面尚未就绪')
        const command = toV2ControlCommand(intent)
        active.setCommand(command)
        onIntent(vehicleId, command)
        await active.tick()
      },
      onChange: (value) => { if (mounted.current) setInputState(value) },
      onError: (error) => {
        controller.current?.fail(error instanceof Error ? error.message : '输入处理失败')
      },
    })
    const monitor = new GamepadInput(controls, (value) => { if (mounted.current) setPad(value) })
    monitor.setMapping(v2GamepadMapping)
    setMapping({ ...v2GamepadMapping })
    input.current = controls
    gamepad.current = monitor
    const unbindKeyboard = bindKeyboardInput(controls, window, document)
    const unbindGamepad = bindGamepadInput(monitor, window, document, navigator)
    const release = () => {
      controls.suspend('页面离开：输入已停止')
      if (controller.current) void controller.current.release().catch(() => {
        if (mounted.current) render((n) => n + 1)
        else console.error('模拟控制释放未确认；需检查 Gateway 交接状态')
      })
    }
    const hidden = () => { if (document.hidden) release() }
    window.addEventListener('blur', release)
    window.addEventListener('pagehide', release)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      mounted.current = false
      unbindGamepad()
      unbindKeyboard()
      window.removeEventListener('blur', release)
      window.removeEventListener('pagehide', release)
      document.removeEventListener('visibilitychange', hidden)
      release()
      onIntent(vehicleId)
    }
  }, [bearer, vehicleId, onIntent])

  useEffect(() => {
    controller.current?.setMediaReady(videoReady)
    changed()
  }, [videoReady, changed])

  const acquire = async () => {
    if (!mediaReady.current) return
    if (controller.current && !['idle', 'closed'].includes(controller.current.state)) return
    if (!globalThis.crypto?.subtle || typeof crypto.randomUUID !== 'function') {
      setMessage('模拟签名要求 HTTPS 或 localhost，以及支持 Ed25519 的浏览器；不会降级到旧协议。')
      return
    }
    setMessage('')
    const room = new Room({ adaptiveStream: false, dynacast: false })
    const next = new ControlSessionClient(vehicleId, teleopConfig.gatewayUrl, bearer, {
      connect: async (token) => { await room.connect(teleopConfig.livekitUrl, token, { autoSubscribe: false }) },
      publish: async (body) => {
        await room.localParticipant.publishData(new Uint8Array(body), { reliable: true, topic: 'vehicle.control.v2',
          destinationIdentities: [`vehicle-${vehicleId}`] })
      },
      disconnect: async () => { await room.disconnect() },
    }, changed)
    next.setMediaReady(mediaReady.current)
    controller.current = next
    room.on(RoomEvent.DataReceived, (body, participant, kind, topic) => {
      if (topic === 'vehicle.control.feedback.v2') {
        next.acceptFeedback(participant?.identity ?? '', kind === DataPacket_Kind.RELIABLE, body)
      }
    })
    room.on(RoomEvent.Disconnected, () => {
      if (!['releasing', 'pending', 'closed'].includes(next.state)) next.fail('RTC disconnected; release before switching')
    })
    room.on(RoomEvent.Reconnecting, () => next.fail('RTC reconnect requires a new control session'))
    try { await next.acquire() } catch (error) {
      if (mounted.current) setMessage(error instanceof Error ? error.message : 'Control acquire failed')
    }
  }
  const release = async () => {
    input.current?.suspend('正在释放模拟控制权')
    try { await controller.current?.release() } catch (error) {
      if (mounted.current) setMessage(error instanceof Error ? error.message : 'Handover pending')
    }
  }
  const state = controller.current?.state ?? 'idle'
  const ready = state === 'ready' && videoReady
  const busy = state !== 'closed' && state !== 'idle'
  const button = 'rounded border border-amber-600 px-3 py-2 disabled:opacity-40'
  return (
    <section className="rounded-xl border border-amber-700 bg-amber-950/20 p-3 text-xs text-amber-100">
      <p className="font-semibold">模拟控制链路 · 不连接实车执行器</p>
      <p className="mt-1">目标：{vehicleId || '未选择'} · 状态：{state}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={!vehicleId || busy || !videoReady} onClick={() => void acquire()} className={button}>申请模拟控制权</button>
        <button type="button" disabled={!busy} onClick={() => void release()} className={button}>释放并等待模拟交接</button>
        <button type="button" disabled={!ready} className={button}
          onClick={() => input.current?.setKeyboardEnabled(!inputState.keyboardEnabled)}>
          {inputState.keyboardEnabled ? '关闭键盘' : '启用键盘 WASD / 方向键'}
        </button>
        {(['forward', 'reverse', 'left', 'right'] as const).map((action, index) => (
          <button type="button" key={action} disabled={!ready} className={button}
            onPointerDown={(event) => {
              if (event.button !== 0) return
              event.currentTarget.setPointerCapture(event.pointerId)
              input.current?.beginPointer({ mode: 'high_level', action })
            }} onPointerUp={() => input.current?.endPointer()}
            onPointerCancel={() => input.current?.endPointer()}
            onLostPointerCapture={() => input.current?.endPointer()}>
            按住{['前进', '倒车', '左转', '右转'][index]}
          </button>
        ))}
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
      <p className="mt-2">{videoReady ? '三路画面正在出帧' : '三路画面未就绪：禁止启用输入；画面恢复不会自动恢复控制'}</p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <select aria-label="模拟控制手柄" className="rounded border border-amber-800 bg-slate-950 p-2"
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
        <span>左摇杆 X 转向 / 右摇杆 Y 前后 · LB 按住使能 · B 模拟制动；先松键回中</span>
      </div>
      <p className="mt-2">{inputState.message} · {pad?.validation || pad?.message}</p>
      {pad?.pad && <p className="mt-1">轴：{pad.pad.axes.map((value) => value.toFixed(2)).join(' / ')} · 按下按钮：{pad.pad.buttons.flatMap((value, index) => value.pressed ? [index] : []).join(', ') || '无'}</p>}
      <p className="mt-2">挡位和自动驾驶模式请求未接入 v2，不开放 1–4 / E / Q 及对应手柄动作；不回退到 v1。</p>
      <p className="mt-2">键盘为离散请求，W+A 等组合方向会停止；手柄为比例输入，两者互斥。前三相机无后视覆盖，倒车仅限隔离模拟验收。</p>
      <p className="mt-2">反馈序号：{controller.current?.feedback?.accepted_sequence ?? '—'}；
        {controller.current?.feedback?.reason ?? '等待车端 v2 SDK'}。仅证明模拟验包，不代表物理执行。失焦、断线或反馈超时停止发令；交接完成前禁止切换。</p>
      <p data-testid="control-feedback" data-sequence={controller.current?.feedback?.accepted_sequence}
        data-command={JSON.stringify(controller.current?.feedback?.command)} className="mt-2">
        模拟设定（非底盘实测）：
        {controller.current?.feedback?.command ? `转向 ${controller.current.feedback.command.steering}‰ · 油门 ${controller.current.feedback.command.throttle}‰ · 制动 ${controller.current.feedback.command.brake}‰ · 方向 ${controller.current.feedback.command.direction}` : '等待反馈'}
      </p>
      {(message || controller.current?.error) && <p role="alert" className="mt-2 text-red-300">{message || controller.current?.error}</p>}
      <div className="fixed inset-x-0 bottom-0 z-[60] flex flex-wrap items-center justify-end gap-3 border-t border-amber-800 bg-slate-950 p-3 text-xs">
        <span>{vehicleId} · {state} · {inputState.gamepadEnabled ? '手柄' : inputState.keyboardEnabled ? '键盘' : '输入未启用'} · 仅模拟</span>
        <button type="button" disabled={!ready} className={button} onClick={() => input.current?.suspend('已发送停止，请重新启用输入')}>停止并停用输入</button>
        <button type="button" disabled={!ready} className="rounded border border-red-500 bg-red-950 px-4 py-2 disabled:opacity-40" onClick={() => input.current?.emergencyStop()}>模拟制动（Space）</button>
      </div>
    </section>
  )
}
