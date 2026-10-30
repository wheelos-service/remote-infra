import React, { useEffect, useRef, useState } from 'react'
import { DataPacket_Kind, Room, RoomEvent } from 'livekit-client'
import { teleopConfig } from '../lib/teleop-config'
import { SimulationController } from '../lib/simulation-controller'
import { neutralCommand } from '../lib/control-protocol'

export function SimulationControlPanel({ vehicleId, bearer, onBusyChange }: {
  vehicleId: string
  bearer: string
  onBusyChange: (busy: boolean) => void
}) {
  const controller = useRef<SimulationController | undefined>(undefined)
  const [, render] = useState(0)
  const [message, setMessage] = useState('')

  useEffect(() => {
    const release = () => {
      if (controller.current) void controller.current.release().catch(() => {
        // The controller retains the pending fence and exposes the error.
        render((n) => n + 1)
      })
    }
    const hidden = () => { if (document.hidden) release() }
    window.addEventListener('blur', release)
    window.addEventListener('pagehide', release)
    document.addEventListener('visibilitychange', hidden)
    return () => {
      window.removeEventListener('blur', release)
      window.removeEventListener('pagehide', release)
      document.removeEventListener('visibilitychange', hidden)
      release()
    }
  }, [bearer, vehicleId])

  const changed = () => {
    const state = controller.current?.state
    onBusyChange(Boolean(state && state !== 'closed' && state !== 'idle'))
    render((n) => n + 1)
  }

  const acquire = async () => {
    setMessage('')
    const room = new Room({ adaptiveStream: false, dynacast: false })
    const next = new SimulationController(vehicleId, teleopConfig.gatewayUrl, bearer, {
      connect: async (token) => { await room.connect(teleopConfig.livekitUrl, token, { autoSubscribe: false }) },
      publish: async (body) => {
        await room.localParticipant.publishData(new Uint8Array(body), { reliable: true, topic: 'vehicle.control.v2' })
      },
      disconnect: async () => { await room.disconnect() },
    }, changed)
    controller.current = next
    room.on(RoomEvent.DataReceived, (body, participant, kind, topic) => {
      if (topic === 'vehicle.control.feedback.v2') {
        next.acceptFeedback(participant?.identity ?? '', kind === DataPacket_Kind.RELIABLE, body)
      }
    })
    room.on(RoomEvent.Disconnected, () => {
      if (next.state !== 'releasing' && next.state !== 'pending' && next.state !== 'closed') {
        next.fail('RTC disconnected; release before switching')
      }
    })
    room.on(RoomEvent.Reconnecting, () => next.fail('RTC reconnect requires a new control session'))
    try { await next.acquire() } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Control acquire failed')
    }
  }

  const release = async () => {
    try { await controller.current?.release() } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Handover pending')
    }
  }
  const state = controller.current?.state ?? 'idle'
  const ready = state === 'ready'
  const busy = state !== 'closed' && state !== 'idle'
  return (
    <section className="rounded-xl border border-amber-700 bg-amber-950/20 p-3 text-xs text-amber-100">
      <p className="font-semibold">模拟控制链路 · 不连接实车执行器</p>
      <p className="mt-1">目标：{vehicleId || '未选择'} · 状态：{state}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <button type="button" disabled={!vehicleId || busy} onClick={() => void acquire()}
          className="rounded border border-amber-600 px-3 py-2 disabled:opacity-40">申请模拟控制权</button>
        <button type="button" disabled={!busy} onClick={() => void release()}
          className="rounded border border-amber-600 px-3 py-2 disabled:opacity-40">释放并等待模拟交接</button>
        <button type="button" disabled={!ready}
          onPointerDown={(event) => {
            event.currentTarget.setPointerCapture(event.pointerId)
            controller.current?.setCommand({ steering: 0, throttle: 100, brake: 0, direction: 1 })
          }}
          onPointerUp={() => { if (controller.current?.state === 'ready') controller.current.setCommand(neutralCommand) }}
          onPointerCancel={() => { if (controller.current?.state === 'ready') controller.current.setCommand(neutralCommand) }}
          onLostPointerCapture={() => { if (controller.current?.state === 'ready') controller.current.setCommand(neutralCommand) }}
          className="rounded border border-amber-600 px-3 py-2 disabled:opacity-40">按住发送模拟前进</button>
      </div>
      <p className="mt-2">反馈序号：{controller.current?.feedback?.accepted_sequence ?? '—'}；
        {controller.current?.feedback?.reason ?? '等待车端 v2 SDK'}。失焦、断线或反馈超时停止发令；交接完成前禁止切换。</p>
      {(message || controller.current?.error) && <p role="alert" className="mt-2 text-red-300">{message || controller.current?.error}</p>}
    </section>
  )
}
