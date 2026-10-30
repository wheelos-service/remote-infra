import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Room, RoomEvent } from 'livekit-client'
import type { Track as LiveKitTrack } from 'livekit-client'
import { AlertTriangle, Camera, Maximize2, Radio, X } from 'lucide-react'
import { useAuth } from '../app/AuthProvider'
import { teleopConfig } from '../lib/teleop-config'
import { isVehicleVideoSender, newViewingId } from '../lib/viewing-api'
import { ViewingLifecycle } from '../lib/viewing-lifecycle'
import { SimulationControlPanel } from './SimulationControlPanel'
import { CameraView, trackCameraName, visibleCameras, type CameraName, type ViewMode } from '../lib/camera-view'
import type { ControlCommand } from '../lib/control-protocol'

type ObserverStatus = 'connecting' | 'waiting-video' | 'watching' | 'error'
const MAX_OBSERVERS = 4
const previewMode = new URLSearchParams(window.location.search).get('preview') === '1'

interface WorkbenchVehicle {
  id: string
  name: string
  occupancy: 'free' | 'occupied' | 'unknown'
  gear?: string
}

interface TeleopWorkbenchProps {
  vehicles: WorkbenchVehicle[]
  directoryReady: boolean
  onActiveChange?: (activeSessionCount: number) => void
}

const TeleopWorkbench: React.FC<TeleopWorkbenchProps> = ({ vehicles, directoryReady, onActiveChange }) => {
  const { accessToken, operator, loading, error, isDevLoginAvailable, signInWithDevToken } = useAuth()
  const [selectedVehicleId, setSelectedVehicleId] = useState('')
  const [focusedVehicleId, setFocusedVehicleId] = useState('')
  const [observerIds, setObserverIds] = useState<string[]>([])
  const [activeCount, setActiveCount] = useState(0)
  const [controlBusy, setControlBusy] = useState(false)
  const [controlIntent, setControlIntent] = useState<{ vehicleId: string; command: ControlCommand }>()
  const noteIntent = useCallback((vehicleId: string, command?: ControlCommand) => {
    setControlIntent(command ? { vehicleId, command } : undefined)
  }, [])
  const [observerBearer, setObserverBearer] = useState(accessToken)
  const activeObserversRef = useRef(new Set<string>())
  const clientInstanceId = useRef(newViewingId())

  const setObserverActive = useCallback((vehicleId: string, active: boolean) => {
    if (active) activeObserversRef.current.add(vehicleId)
    else activeObserversRef.current.delete(vehicleId)
    const count = activeObserversRef.current.size
    setActiveCount(count)
  }, [])

  useEffect(() => {
    onActiveChange?.(activeCount + Number(controlBusy))
  }, [activeCount, controlBusy, onActiveChange])
  useEffect(() => () => onActiveChange?.(0), [onActiveChange])

  useEffect(() => {
    if (!vehicles.some((vehicle) => vehicle.id === selectedVehicleId)) {
      setSelectedVehicleId(vehicles[0]?.id ?? '')
    }
  }, [selectedVehicleId, vehicles])

  useEffect(() => {
    if (controlBusy) return
    if (directoryReady && !vehicles.some((vehicle) => vehicle.id === focusedVehicleId)) {
      setFocusedVehicleId('')
    }
  }, [controlBusy, directoryReady, focusedVehicleId, vehicles])

  useEffect(() => {
    if (!accessToken && !previewMode) {
      setObserverIds([])
      activeObserversRef.current.clear()
      setActiveCount(0)
    }
  }, [accessToken, onActiveChange])

  useEffect(() => {
    if (observerBearer === accessToken) return
    setFocusedVehicleId('')
    setControlBusy(false)
    setControlIntent(undefined)
    setObserverIds([])
    activeObserversRef.current.clear()
    setActiveCount(0)
    setObserverBearer(accessToken)
  }, [accessToken, observerBearer, onActiveChange])

  useEffect(() => {
    if (previewMode || !directoryReady) return
    if (observerIds.some((id) => !vehicles.some((vehicle) => vehicle.id === id))) {
      setObserverIds((previous) => previous.filter((id) => vehicles.some((vehicle) => vehicle.id === id)))
    }
  }, [directoryReady, observerIds, vehicles])

  useEffect(() => {
    if (activeCount === 0 && !controlBusy) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [activeCount, controlBusy])

  if (loading && !previewMode) {
    return <WorkbenchMessage title="正在校验登录状态" detail="请稍候…" />
  }
  if (!previewMode && !accessToken) {
    return (
      <WorkbenchMessage
        title="远程监看工作台"
        detail={error || '请先从平台右上角登录。登录身份用于车辆业务及视频鉴权。'}
      >
        {isDevLoginAvailable && (
          <button
            type="button"
            onClick={() => void signInWithDevToken()}
            className="mt-4 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-slate-500"
          >
            本地开发登录
          </button>
        )}
      </WorkbenchMessage>
    )
  }

  const addObserver = () => {
    if (!previewMode && !accessToken) return
    if (!previewMode && accessToken !== observerBearer) return
    if (!vehicles.some((vehicle) => vehicle.id === selectedVehicleId)) return
    setObserverIds((previous) => {
      if (previous.length >= MAX_OBSERVERS || previous.includes(selectedVehicleId)) return previous
      return [...previous, selectedVehicleId]
    })
  }

  const removeObserver = (vehicleId: string) => {
    setObserverIds((previous) => previous.filter((id) => id !== vehicleId))
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-slate-100">远程监看工作台</h1>
            <span className="rounded-full border border-amber-700/60 bg-amber-950/30 px-2 py-0.5 text-[11px] text-amber-200">
              {previewMode ? '界面预览' : '只读监看'}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {operator?.Name ? `登录身份：${operator.Name} · ` : ''}每个车辆面板拥有独立观看租约与 LiveKit Room。
          </p>
        </div>
        <div className="flex items-center gap-2 rounded-full border border-slate-800 bg-slate-900 px-3 py-1 text-xs text-slate-300">
          <Radio className="h-3.5 w-3.5 text-sky-300" />
          {observerIds.length}/{MAX_OBSERVERS} 个监看面板
        </div>
      </header>

      <section className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-3">
        <div className="min-w-52 flex-1">
          <label htmlFor="observer-vehicle" className="block text-xs text-slate-400">授权车辆</label>
          <select
            id="observer-vehicle"
            value={selectedVehicleId}
            onChange={(event) => setSelectedVehicleId(event.target.value)}
            className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100"
          >
            <option value="">选择车辆</option>
            {vehicles.map((vehicle) => (
              <option key={vehicle.id} value={vehicle.id}>
                {vehicle.name || vehicle.id} · {occupancyLabel(vehicle.occupancy)}
              </option>
            ))}
          </select>
        </div>
        <button
          type="button"
          onClick={() => setFocusedVehicleId(selectedVehicleId)}
          disabled={!selectedVehicleId || !directoryReady || controlBusy}
          className="rounded-lg border border-sky-700 px-4 py-2 text-sm text-sky-200 disabled:opacity-50"
        >
          设为操作目标
        </button>
        <button
          type="button"
          onClick={addObserver}
          disabled={!selectedVehicleId || observerIds.length >= MAX_OBSERVERS || observerIds.includes(selectedVehicleId)}
          className="rounded-lg bg-sky-500 px-4 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          {previewMode ? '打开预览面板' : '开始只读监看'}
        </button>
        <span className="text-[11px] text-slate-500">
          仅查看占用状态，不申请控制权；未知占用不会显示为空闲。
        </span>
      </section>

      <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-3 text-xs text-slate-300">
        <p>
          当前操作目标：{vehicles.find((vehicle) => vehicle.id === focusedVehicleId)?.name || focusedVehicleId || '未选择'}
          {' · '}当前工作台控制车辆：{controlBusy ? '模拟会话占用中' : '无（实车驾驶未开放）'}
        </p>
        <p className="mt-1 text-slate-500">
          可切换操作目标，也可同时监看多辆车；选中不申请控制权。驾驶开放后，同一账号同时只能控制一辆车，
          必须释放原车并确认交接后才能控制下一辆车。
        </p>
      </section>

      {teleopConfig.simulationControl && !previewMode && focusedVehicleId && accessToken && (
        <SimulationControlPanel key={`${focusedVehicleId}:${accessToken}`}
          vehicleId={focusedVehicleId} bearer={accessToken} onBusyChange={setControlBusy} onIntent={noteIntent} />
      )}

      {previewMode && (
        <div className="rounded-lg border border-amber-800/60 bg-amber-950/20 px-4 py-3 text-xs text-amber-100">
          预览模式不发起认证、租约或 LiveKit 请求，不发送任何车辆命令。
        </div>
      )}

      {observerIds.length > 0 ? (
        <div className="grid min-h-0 flex-1 gap-4 sm:grid-cols-2 2xl:grid-cols-4">
          {observerBearer === accessToken && observerIds.map((id) => {
            const vehicle = vehicles.find((entry) => entry.id === id)
            return (
              <ObserverPanel
                key={id}
                vehicleId={id}
                vehicleName={vehicle?.name || id}
                occupancy={vehicle?.occupancy ?? 'unknown'}
                gear={vehicle?.gear}
                intent={controlIntent?.vehicleId === id ? controlIntent.command : undefined}
                bearer={accessToken}
                clientInstanceId={clientInstanceId.current}
                preview={previewMode}
                onActiveChange={setObserverActive}
                onClose={() => removeObserver(id)}
              />
            )
          })}
        </div>
      ) : (
        <section className="flex min-h-[360px] flex-1 items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900/30 p-6 text-center">
          <div>
            <Camera className="mx-auto h-8 w-8 text-slate-500" />
            <h2 className="mt-3 text-sm font-medium text-slate-300">尚未开始监看</h2>
            <p className="mt-1 max-w-md text-xs leading-5 text-slate-500">
              选择一辆授权车辆后显式开始只读监看。车队与业务状态页面不会申请观看租约。最多可同时打开四辆车的独立视频会话。
            </p>
          </div>
        </section>
      )}

      <section className="flex items-start gap-2 rounded-xl border border-amber-800/60 bg-amber-950/20 p-3 text-xs text-amber-100/80">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <p>
          实车控制与模式切换保持关闭。显式启用的 v2 模拟输入不连接执行器；切换目标不转移驾驶权，必须等待原车交接确认。
        </p>
      </section>
    </div>
  )
}

const ObserverPanel: React.FC<{
  vehicleId: string
  vehicleName: string
  occupancy: WorkbenchVehicle['occupancy']
  gear?: string
  intent?: ControlCommand
  bearer?: string
  clientInstanceId: string
  preview: boolean
  onActiveChange(vehicleId: string, active: boolean): void
  onClose(): void
}> = ({ vehicleId, vehicleName, occupancy, gear, intent, bearer, clientInstanceId, preview, onActiveChange, onClose }) => {
  const [status, setStatus] = useState<ObserverStatus>(preview ? 'waiting-video' : 'connecting')
  const [message, setMessage] = useState<string>()
  const [tracks, setTracks] = useState<Partial<Record<CameraName, LiveKitTrack>>>({})
  const roomRef = useRef<Room | undefined>(undefined)
  const lifecycleRef = useRef<ViewingLifecycle | undefined>(undefined)
  const videoAreaRef = useRef<HTMLDivElement | null>(null)
  const mountedRef = useRef(true)
  const cameraView = useRef(new CameraView())
  const [, updateView] = useState(0)
  const [centerFocused, setCenterFocused] = useState(false)
  const [viewMode, setViewMode] = useState<ViewMode>('auto')

  useEffect(() => {
    const view = cameraView.current
    const previous = view.group
    if (intent) view.command({
      mode: 'low_level', steering: intent.steering / 1000, throttle: intent.throttle / 1000,
      brake: intent.brake / 1000, direction: intent.direction,
    })
    else view.clearIntent()
    view.gear(gear)
    if (previous !== view.group) setCenterFocused(false)
    updateView((value) => value + 1)
  }, [gear, intent])

  useEffect(() => {
    mountedRef.current = true
    if (preview || !bearer) return
    let active = true
    let lifecycle!: ViewingLifecycle
    const currentTracks: Partial<Record<CameraName, LiveKitTrack>> = {}
    onActiveChange(vehicleId, true)
    setStatus('connecting')
    lifecycle = new ViewingLifecycle({
      vehicleId,
      bearer,
      clientInstanceId,
      createObserver: (livekitToken) => {
        const room = new Room({ adaptiveStream: true, dynacast: true })
        roomRef.current = room
        room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
          if (!active || roomRef.current !== room || !lifecycle.active || track.kind !== 'video') return
          if (!isVehicleVideoSender(participant.identity, vehicleId)) {
            track.detach()
            return
          }
          const name = trackCameraName(publication.trackName || '')
          if (!name) {
            track.detach()
            if (mountedRef.current) setMessage(`忽略未识别的视频轨道：${publication.trackName || '未命名'}`)
            return
          }
          currentTracks[name] = track
          if (mountedRef.current) {
            setTracks({ ...currentTracks })
            setStatus('watching')
            setMessage(undefined)
          }
        })
        room.on(RoomEvent.TrackUnsubscribed, (track, publication, participant) => {
          if (!active || roomRef.current !== room || !lifecycle.active ||
              !isVehicleVideoSender(participant.identity, vehicleId)) return
          const name = trackCameraName(publication.trackName || '')
          if (!name) return
          if (currentTracks[name] === track) delete currentTracks[name]
          if (mountedRef.current) {
            setTracks({ ...currentTracks })
            setStatus(Object.keys(currentTracks).length ? 'watching' : 'waiting-video')
          }
        })
        room.on(RoomEvent.Disconnected, () => {
          if (roomRef.current === room) lifecycle.fail(new Error('LiveKit 连接已断开，请重新连接'))
        })
        room.on(RoomEvent.Reconnecting, () => {
          if (!active || roomRef.current !== room || !lifecycle.active) return
          if (mountedRef.current) {
            setStatus('connecting')
            setMessage('视频链路正在恢复')
          }
        })
        room.on(RoomEvent.Reconnected, () => {
          if (!active || roomRef.current !== room || !lifecycle.active) return
          if (mountedRef.current) {
            setStatus(Object.keys(currentTracks).length ? 'watching' : 'waiting-video')
            setMessage(undefined)
          }
        })
        return {
          connect: () => room.connect(teleopConfig.livekitUrl, livekitToken),
          disconnect: () => room.disconnect(),
        }
      },
      onConnected: () => {
        if (!active || !mountedRef.current) return
        setStatus(Object.keys(currentTracks).length ? 'watching' : 'waiting-video')
        setMessage(Object.keys(currentTracks).length ? undefined : '等待车辆视频轨道；连接不代表视频已就绪')
      },
      onError: (cause) => {
        if (!active || !mountedRef.current) return
        setStatus('error')
        setMessage(cause instanceof Error ? cause.message : '监看连接失败')
        onActiveChange(vehicleId, false)
      },
      onCleanupError: () => {
        console.error('关闭监看连接或释放租约失败；停止续期后由租约 TTL 回收')
        if (mountedRef.current) setMessage('释放监看资源失败；租约将在期限内自动失效')
      },
    })
    lifecycleRef.current = lifecycle
    void lifecycle.start()

    const stopOnPageHide = () => { void lifecycle.stop() }
    window.addEventListener('pagehide', stopOnPageHide)
    return () => {
      active = false
      window.removeEventListener('pagehide', stopOnPageHide)
      mountedRef.current = false
      if (lifecycleRef.current === lifecycle) lifecycleRef.current = undefined
      roomRef.current = undefined
      onActiveChange(vehicleId, false)
      void lifecycle.stop()
    }
  }, [bearer, clientInstanceId, onActiveChange, preview, vehicleId])

  const groupCameras = visibleCameras(cameraView.current.group, tracks)
  const centerName = cameraView.current.group === 'rear' ? 'rear-center' : 'center'
  const visibleTracks = centerFocused && tracks[centerName]
    ? groupCameras.filter(({ name }) => name === centerName) : groupCameras
  const hasVisibleVideo = visibleTracks.some(({ name }) => tracks[name])
  const occupancyText = occupancyLabel(occupancy)

  return (
    <section className="flex min-h-[280px] min-w-0 flex-col overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
      <header className="flex items-start justify-between gap-2 border-b border-slate-800 px-3 py-2">
        <div className="min-w-0">
          <h2 className="truncate text-sm font-medium text-slate-100">{vehicleName}</h2>
          <p className="mt-0.5 truncate text-[10px] text-slate-500">{vehicleId}</p>
        </div>
        <button type="button" onClick={onClose} aria-label={`关闭 ${vehicleName} 监看面板`} className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-100">
          <X className="h-4 w-4" />
        </button>
      </header>
      <div className="flex items-center justify-between gap-2 px-3 py-2 text-[10px]">
        <span className={status === 'watching' ? 'text-emerald-300' : status === 'error' ? 'text-rose-300' : 'text-amber-200'}>
          {preview ? '模拟画面 · 非实时' : observerStatusLabel(status)}
        </span>
        <span className="text-slate-500">操作占用：{occupancyText}</span>
      </div>
      <div className="flex flex-wrap gap-2 px-3 pb-2 text-[10px] text-slate-300">
        <select aria-label={`${vehicleName} 摄像头视角`} value={viewMode}
          onChange={(event) => {
            const mode = event.target.value
            if (mode !== 'auto' && mode !== 'front' && mode !== 'rear') return
            cameraView.current.setMode(mode)
            setViewMode(mode)
            setCenterFocused(false)
            updateView((value) => value + 1)
          }} className="rounded border border-slate-700 bg-slate-950 p-1">
          <option value="auto">自动前后视角</option><option value="front">前方</option><option value="rear">后方</option>
        </select>
        <button type="button" disabled={!tracks[centerName]} onClick={() => setCenterFocused((value) => !value)}
          className="rounded border border-slate-700 px-2 disabled:opacity-40">{centerFocused ? '恢复三路' : '放大中间'}</button>
        <span>{cameraView.current.status}（运营快照仅辅助选视角，不证明执行）</span>
      </div>
      <div ref={videoAreaRef} className="relative min-h-[210px] flex-1 bg-black">
        {preview ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-slate-950 p-4 text-center">
            <Camera className="h-7 w-7 text-slate-500" />
            <p className="text-xs text-slate-300">{vehicleName}</p>
            <p className="text-[10px] text-slate-500">固定预览场景，不会连接车辆。</p>
          </div>
        ) : hasVisibleVideo ? (
          <div className={`grid h-full min-h-[210px] ${visibleTracks.length > 1 ? 'grid-cols-3' : 'grid-cols-1'}`}>
            {visibleTracks.map(({ name, label }) => (
              <VideoTile key={name} track={tracks[name]} label={label} />
            ))}
          </div>
        ) : (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center">
            <Camera className="h-7 w-7 text-slate-600" />
            <p className="text-xs text-slate-400">{status === 'error' ? '视频不可用' : '等待视频轨道'}</p>
            {message && <p className="text-[10px] text-slate-500">{message}</p>}
          </div>
        )}
        {message && hasVisibleVideo && (
          <p className="absolute inset-x-0 bottom-0 bg-slate-950/85 px-2 py-1 text-[10px] text-amber-200">{message}</p>
        )}
        {!preview && hasVisibleVideo && (
          <button
            type="button"
            onClick={() => void videoAreaRef.current?.requestFullscreen().catch(() => setMessage('无法进入全屏'))}
            title="全屏"
            className="absolute right-2 top-2 rounded border border-slate-700 bg-slate-950/80 p-1.5 text-slate-200"
          >
            <Maximize2 className="h-3.5 w-3.5" />
          </button>
        )}
      </div>
      <footer className="border-t border-slate-800 px-3 py-2 text-[10px] text-slate-500">
        独立观看租约 · 只读 · 仅挂接当前视角，保留 adaptiveStream；不承诺隐藏轨道即停止车端上行
      </footer>
    </section>
  )
}

const VideoTile: React.FC<{ track?: LiveKitTrack; label: string }> = ({ track, label }) => {
  const containerRef = useRef<HTMLDivElement>(null)
  const [frameState, setFrameState] = useState('等待解码帧')
  useEffect(() => {
    setFrameState('等待解码帧')
    if (!track || !containerRef.current) return
    const element = track.attach()
    element.muted = true
    element.autoplay = true
    const video = element instanceof HTMLVideoElement ? element : undefined
    if (video) video.playsInline = true
    let active = true
    let lastFrame = Number.NEGATIVE_INFINITY
    let frameId: number | undefined
    const fresh = () => {
      if (!active) return
      lastFrame = performance.now()
      setFrameState('已解码画面（非延迟保证）')
    }
    const frames = Boolean(video && typeof video.requestVideoFrameCallback === 'function')
    const frame = () => {
      fresh()
      if (active && video) frameId = video.requestVideoFrameCallback(frame)
    }
    const progress = () => { if (!frames && element.readyState >= 2) fresh() }
    const stalled = () => { if (active) setFrameState('画面停止 / 不可用') }
    element.addEventListener('timeupdate', progress)
    element.addEventListener('loadeddata', progress)
    const events = ['waiting', 'stalled', 'ended', 'error', 'emptied']
    for (const event of events) element.addEventListener(event, stalled)
    if (frames && video) frameId = video.requestVideoFrameCallback(frame)
    const timer = setInterval(() => { if (performance.now() - lastFrame > 2000) stalled() }, 500)
    element.className = 'h-full w-full bg-black object-contain'
    containerRef.current.replaceChildren(element)
    return () => {
      active = false
      clearInterval(timer)
      if (frameId !== undefined && video) video.cancelVideoFrameCallback(frameId)
      element.removeEventListener('timeupdate', progress)
      element.removeEventListener('loadeddata', progress)
      for (const event of events) element.removeEventListener(event, stalled)
      track.detach(element)
      element.remove()
    }
  }, [track])
  return (
    <div className="relative min-h-[210px] overflow-hidden border border-slate-800 bg-black">
      <div ref={containerRef} className="absolute inset-0" />
      {!track && <p className="p-3 text-xs text-slate-500">尚无此路视频</p>}
      <span className="absolute left-2 top-2 rounded bg-slate-950/80 px-2 py-1 text-[10px] text-slate-200">{label}</span>
      {track && <span className="absolute inset-x-0 bottom-0 bg-slate-950/80 px-2 py-1 text-[10px] text-amber-200">{frameState}</span>}
    </div>
  )
}

const WorkbenchMessage: React.FC<React.PropsWithChildren<{ title: string; detail: string }>> = ({
  title,
  detail,
  children,
}) => (
  <section className="mx-auto flex min-h-[70vh] max-w-xl items-center justify-center">
    <div className="w-full rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl">
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-sky-500/10 text-sky-300">
        <Radio className="h-5 w-5" />
      </div>
      <h1 className="text-lg font-semibold text-slate-100">{title}</h1>
      <p className="mt-2 text-sm leading-6 text-slate-400">{detail}</p>
      {children}
    </div>
  </section>
)

function occupancyLabel(value: WorkbenchVehicle['occupancy']): string {
  if (value === 'free') return '空闲（目录快照）'
  if (value === 'occupied') return '已占用'
  return '未知'
}

function observerStatusLabel(status: ObserverStatus): string {
  if (status === 'connecting') return '连接中'
  if (status === 'waiting-video') return '等待视频'
  if (status === 'watching') return '视频已接收'
  return '连接异常'
}

export default TeleopWorkbench
