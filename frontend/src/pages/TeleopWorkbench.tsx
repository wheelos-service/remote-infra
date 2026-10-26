import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Room, RoomEvent } from 'livekit-client'
import type { Track as LiveKitTrack } from 'livekit-client'
import {
  AlertTriangle,
  Camera,
  CheckCircle2,
  Maximize2,
  Minimize2,
  Radio,
  RefreshCw,
  ShieldCheck,
  Wifi,
  X,
} from 'lucide-react'
import { useAuth } from '../app/AuthProvider'
import { teleopConfig } from '../lib/teleop-config'

type CameraName = 'front' | 'left' | 'center' | 'right'
type WorkbenchStatus = 'idle' | 'connecting' | 'waiting-video' | 'watching' | 'error' | 'preview'

interface WorkbenchVehicle {
  id: string
  name: string
  locationLabel: string
}

interface TokenResponse {
  token?: string
}

const cameras: { name: CameraName; label: string }[] = [
  { name: 'front', label: '前视相机' },
  { name: 'left', label: '左侧相机' },
  { name: 'center', label: '中间相机' },
  { name: 'right', label: '右侧相机' },
]

const gatewayUrl = teleopConfig.gatewayUrl.replace(/\/$/, '')
const connectionTimeoutMs = 15_000
const interfacePreviewMode = new URLSearchParams(window.location.search).get('preview') === '1'

interface TeleopWorkbenchProps {
  vehicles: WorkbenchVehicle[]
  onActiveChange?: (active: boolean) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : '未知错误'
}

async function responseError(response: Response): Promise<Error> {
  const detail = (await response.text()).trim()
  return new Error(detail || `请求失败 (${response.status})`)
}

function cameraName(trackName: string): CameraName | undefined {
  const normalized = trackName === 'camera' ? 'front' : trackName.replace(/^camera-/, '')
  return cameras.some((camera) => camera.name === normalized)
    ? (normalized as CameraName)
    : undefined
}

const TeleopWorkbench: React.FC<TeleopWorkbenchProps> = ({ vehicles, onActiveChange }) => {
  const {
    accessToken,
    operator,
    loading: authLoading,
    error: authError,
    isDevLoginAvailable,
    signInWithDevToken,
    signOut,
  } = useAuth()
  const [vehicleId, setVehicleId] = useState('')
  const [activeVehicleId, setActiveVehicleId] = useState<string>()
  const [previewVehicleId, setPreviewVehicleId] = useState<string>()
  const [status, setStatus] = useState<WorkbenchStatus>('idle')
  const [message, setMessage] = useState<string>()
  const [tracks, setTracks] = useState<Partial<Record<CameraName, LiveKitTrack>>>({})
  const [fullscreen, setFullscreen] = useState(false)
  const roomRef = useRef<Room | undefined>(undefined)
  const tracksRef = useRef<Partial<Record<CameraName, LiveKitTrack>>>({})
  const videoAreaRef = useRef<HTMLDivElement>(null)
  const generationRef = useRef(0)

  useEffect(() => {
    const onFullscreenChange = () => {
      setFullscreen(document.fullscreenElement === videoAreaRef.current)
    }
    document.addEventListener('fullscreenchange', onFullscreenChange)
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange)
  }, [])

  const hasActiveConnection = status === 'connecting' || Boolean(activeVehicleId)

  useEffect(() => {
    onActiveChange?.(hasActiveConnection)
    return () => onActiveChange?.(false)
  }, [hasActiveConnection, onActiveChange])

  useEffect(() => {
    if (!hasActiveConnection) return
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', warnBeforeUnload)
    return () => window.removeEventListener('beforeunload', warnBeforeUnload)
  }, [hasActiveConnection])

  const disconnect = useCallback(async () => {
    generationRef.current += 1
    const room = roomRef.current
    roomRef.current = undefined
    tracksRef.current = {}
    setTracks({})
    setActiveVehicleId(undefined)
    setStatus('idle')
    setMessage(undefined)
    if (room) {
      try {
        await room.disconnect()
      } catch (error) {
        setStatus('error')
        setMessage(`关闭视频连接失败：${errorMessage(error)}`)
      }
    }
  }, [])

  useEffect(() => {
    if (!accessToken) void disconnect()
  }, [accessToken, disconnect])

  useEffect(() => () => {
    generationRef.current += 1
    void roomRef.current?.disconnect().catch((error: unknown) => {
      console.error('Failed to close LiveKit observer connection:', error)
    })
    roomRef.current = undefined
  }, [])

  const connect = async () => {
    const requestedVehicleId = vehicleId.trim()
    const token = accessToken
    if (interfacePreviewMode || !token || !requestedVehicleId || roomRef.current) return

    const generation = ++generationRef.current
    setStatus('connecting')
    setMessage(undefined)
    tracksRef.current = {}
    setTracks({})

    try {
      const response = await fetch(
        `${gatewayUrl}/api/token/operator?vid=${encodeURIComponent(requestedVehicleId)}&access=observer`,
        { headers: { Authorization: `Bearer ${token}` } },
      )
      if (response.status === 401) {
        signOut()
        throw new Error('登录已失效，请从平台顶栏重新登录')
      }
      if (!response.ok) throw await responseError(response)
      const tokenResponse = (await response.json()) as TokenResponse
      if (!tokenResponse.token) throw new Error('网关未返回 LiveKit 访问令牌')
      if (generation !== generationRef.current) return

      setActiveVehicleId(requestedVehicleId)
      const room = new Room({ adaptiveStream: true, dynacast: true })
      roomRef.current = room
      room.on(RoomEvent.TrackSubscribed, (track, publication) => {
        if (roomRef.current !== room || track.kind !== 'video') return
        const name = cameraName(publication.trackName || '')
        if (!name) {
          track.detach()
          setMessage(`忽略未识别的视频轨道：${publication.trackName || '未命名'}`)
          return
        }
        const updated = { ...tracksRef.current, [name]: track }
        tracksRef.current = updated
        setTracks(updated)
        setStatus('watching')
        setMessage(undefined)
      })
      room.on(RoomEvent.TrackUnsubscribed, (track, publication) => {
        if (roomRef.current !== room) return
        const name = cameraName(publication.trackName || '')
        if (!name) return
        const updated = { ...tracksRef.current }
        if (updated[name] === track) delete updated[name]
        tracksRef.current = updated
        setTracks(updated)
        setStatus(Object.keys(updated).length ? 'watching' : 'waiting-video')
        setMessage(Object.keys(updated).length ? undefined : '视频轨道已断开，正在等待车辆重新发布')
      })
      room.on(RoomEvent.Disconnected, () => {
        if (roomRef.current !== room) return
        roomRef.current = undefined
        tracksRef.current = {}
        setTracks({})
        setActiveVehicleId(undefined)
        setStatus('error')
        setMessage('LiveKit 连接已断开，请重新连接')
      })
      room.on(RoomEvent.Reconnecting, () => {
        if (roomRef.current !== room) return
        setStatus('connecting')
        setMessage('视频链路正在恢复')
      })
      room.on(RoomEvent.Reconnected, () => {
        if (roomRef.current !== room) return
        setStatus(Object.keys(tracksRef.current).length ? 'watching' : 'waiting-video')
        setMessage(undefined)
      })

      let timeoutId: number | undefined
      try {
        await Promise.race([
          room.connect(teleopConfig.livekitUrl, tokenResponse.token),
          new Promise<never>((_, reject) => {
            timeoutId = window.setTimeout(
              () => reject(new Error('连接 LiveKit 超时，请检查网络后重试')),
              connectionTimeoutMs,
            )
          }),
        ])
      } finally {
        if (timeoutId !== undefined) window.clearTimeout(timeoutId)
      }
      if (generation !== generationRef.current || roomRef.current !== room) {
        room.disconnect()
        return
      }

      setActiveVehicleId(requestedVehicleId)
      const hasVideo = Object.keys(tracksRef.current).length > 0
      setStatus(hasVideo ? 'watching' : 'waiting-video')
      setMessage(hasVideo ? undefined : '实时视频尚未到达；当前仅监看，不具备控制能力')
    } catch (error) {
      const room = roomRef.current
      roomRef.current = undefined
      void room?.disconnect().catch((disconnectError: unknown) => {
        console.error('Failed to close LiveKit observer connection:', disconnectError)
      })
      if (generation !== generationRef.current) return
      tracksRef.current = {}
      setTracks({})
      setActiveVehicleId(undefined)
      setStatus('error')
      setMessage(errorMessage(error))
    }
  }

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen()
      } else {
        await videoAreaRef.current?.requestFullscreen()
      }
    } catch (error) {
      setMessage(`无法切换全屏：${errorMessage(error)}`)
    }
  }

  if (authLoading && !interfacePreviewMode) {
    return <WorkbenchMessage title="正在校验登录状态" detail="请稍候…" />
  }

  if (!interfacePreviewMode && (!accessToken || !operator)) {
    return (
      <section className="mx-auto flex min-h-[70vh] max-w-xl items-center justify-center">
        <div className="w-full rounded-2xl border border-slate-800 bg-slate-900/80 p-6 shadow-xl">
          <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl bg-sky-500/10 text-sky-300">
            <ShieldCheck className="h-5 w-5" />
          </div>
          <h1 className="text-lg font-semibold text-slate-100">远程接管工作台</h1>
          <p className="mt-2 text-sm leading-6 text-slate-400">
            请先从平台右上角登录。登录身份会显示在框架顶栏，并用于本工作台的视频鉴权。
          </p>
          {authError && <ErrorBanner message={authError} />}
          {isDevLoginAvailable && (
            <button
              type="button"
              onClick={() => void signInWithDevToken()}
              className="mt-4 rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300 hover:border-slate-500"
            >
              本地开发登录
            </button>
          )}
          <p className="mt-4 text-xs text-slate-500">
            登录令牌只保存在页面内存中；刷新页面后请重新登录。
          </p>
        </div>
      </section>
    )
  }

  const previewVehicle = vehicles.find((vehicle) => vehicle.id === previewVehicleId)
  const viewedVehicleId = interfacePreviewMode ? previewVehicleId : activeVehicleId
  const viewIsPreview = interfacePreviewMode || status === 'preview'
  const visibleTracks = cameras.filter((camera) => tracks[camera.name])
  const statusLabel: Record<WorkbenchStatus, string> = {
    idle: '未连接',
    connecting: '连接中',
    'waiting-video': '等待视频',
    watching: '视频已接收 · 只读',
    error: '连接异常',
    preview: '界面预览 · 未连接车辆',
  }
  const isBusy = status === 'connecting'

  const handleVehicleSelect = (id: string) => {
    setVehicleId(id)
    if (interfacePreviewMode) {
      setPreviewVehicleId(id)
      setStatus('preview')
      setMessage(undefined)
      return
    }
    setMessage(undefined)
  }

  const disconnectWorkbench = () => {
    if (interfacePreviewMode) {
      setPreviewVehicleId(undefined)
      setStatus('idle')
      setMessage(undefined)
      return
    }
    void disconnect()
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-slate-100">远程接管工作台</h1>
            <span className="rounded-full border border-amber-600/50 bg-amber-950/40 px-2 py-0.5 text-[11px] text-amber-200">
              {viewIsPreview ? '界面预览' : '只读监看'}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {operator?.Name ? `登录身份：${operator.Name}` : '登录后显示操作员身份'}
            {operator?.Organization ? ` · ${operator.Organization}` : ''}
          </p>
        </div>
      </header>

      <div className="grid gap-4 xl:min-h-0 xl:flex-1 xl:grid-cols-[minmax(0,1fr)_300px]">
        <section className="flex min-h-[420px] min-w-0 flex-col rounded-xl border border-slate-800 bg-slate-900/70 p-3">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-slate-200">
              <Camera className="h-4 w-4 text-sky-300" />
              <span>{viewedVehicleId ? `车辆 ${viewedVehicleId}` : '视频画面'}</span>
              <span className="text-xs text-slate-500">{statusLabel[viewIsPreview ? 'preview' : status]}</span>
            </div>
            <div className="flex items-center gap-2">
              {viewedVehicleId || isBusy ? (
                <button
                  type="button"
                  onClick={disconnectWorkbench}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:border-slate-500"
                >
                  <X className="h-3.5 w-3.5" />
                  {viewIsPreview ? '退出预览' : isBusy ? '取消连接' : '断开'}
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => void toggleFullscreen()}
                disabled={!viewedVehicleId}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-200 hover:border-slate-500 disabled:opacity-40"
              >
                {fullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                {fullscreen ? '退出全屏' : '全屏'}
              </button>
            </div>
          </div>

          <div
            ref={videoAreaRef}
            className={`relative min-h-[340px] flex-1 overflow-hidden rounded-lg bg-black ${
              fullscreen ? 'h-screen w-screen p-3' : ''
            }`}
          >
            {viewIsPreview ? (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-slate-950 px-6 text-center">
                <div className="flex h-12 w-12 items-center justify-center rounded-2xl border border-sky-700/50 bg-sky-950/40 text-sky-300">
                  <Camera className="h-6 w-6" />
                </div>
                <div>
                  <p className="text-sm font-medium text-slate-200">
                    {previewVehicle ? `${previewVehicle.id} · ${previewVehicle.name}` : '接管工作台界面预览'}
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    此为界面预览，不会登录车辆、连接视频或发送控制指令
                  </p>
                </div>
                <span className="rounded-full border border-amber-700/50 bg-amber-950/40 px-3 py-1 text-[11px] text-amber-200">
                  模拟画面 · 非实时
                </span>
              </div>
            ) : visibleTracks.length > 1 ? (
              <div className="grid h-full min-h-[340px] grid-cols-1 gap-1 sm:grid-cols-2">
                {cameras.map((camera) => (
                  <VideoTile
                    key={camera.name}
                    label={camera.label}
                    track={tracks[camera.name]}
                    status={status}
                  />
                ))}
              </div>
            ) : (
              <VideoTile
                label={visibleTracks[0]?.label ?? '前视相机'}
                track={visibleTracks[0] ? tracks[visibleTracks[0].name] : undefined}
                status={status}
              />
            )}
            {!viewIsPreview && activeVehicleId && status === 'connecting' && (
              <div className="absolute inset-x-0 top-0 flex items-center justify-center bg-amber-950/85 px-4 py-2 text-center text-xs text-amber-100">
                视频链路正在恢复，当前画面可能不是实时画面
              </div>
            )}
            {!viewIsPreview && activeVehicleId && status === 'watching' && visibleTracks.length > 0 && (
              <div className="absolute left-3 top-3 flex items-center gap-1.5 rounded-full border border-emerald-700/60 bg-slate-950/80 px-2.5 py-1 text-[11px] text-emerald-200">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                视频轨道已接收
              </div>
            )}
            {fullscreen && (
              <button
                type="button"
                onClick={() => void toggleFullscreen()}
                className="absolute right-3 top-3 z-10 inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-950/90 px-3 py-2 text-xs text-slate-100 hover:border-slate-500"
              >
                <Minimize2 className="h-3.5 w-3.5" />
                退出全屏
              </button>
            )}
          </div>
        </section>

        <aside className="flex flex-col gap-3">
          <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-medium text-slate-100">车辆列表</h2>
              <span className="rounded-full border border-slate-700 px-2 py-0.5 text-[10px] text-slate-400">
                {interfacePreviewMode ? '模拟数据' : '无实时目录'}
              </span>
            </div>
            <div className="max-h-52 space-y-1 overflow-y-auto">
              <button
                type="button"
                onClick={() => handleVehicleSelect('car-001')}
                disabled={!interfacePreviewMode && (Boolean(activeVehicleId) || isBusy)}
                className={`w-full rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  vehicleId === 'car-001'
                    ? 'border-sky-500/70 bg-sky-950/40'
                    : 'border-slate-800 bg-slate-950/50 hover:border-slate-700'
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs font-semibold text-slate-100">car-001</span>
                  <span className="text-[10px] text-sky-300">本地联调示例</span>
                </div>
                <p className="mt-1 text-[11px] text-slate-500">状态需由实际服务确认</p>
              </button>
              {vehicles.map((vehicle) => (
                <button
                  key={vehicle.id}
                  type="button"
                  onClick={() => handleVehicleSelect(vehicle.id)}
                  disabled={!interfacePreviewMode || Boolean(activeVehicleId) || isBusy}
                  title={interfacePreviewMode ? '选择此演示车辆预览界面' : '这是界面演示数据，不可用于真实车辆连接'}
                  className={`w-full rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                    vehicleId === vehicle.id
                      ? 'border-sky-500/70 bg-sky-950/40'
                      : 'border-slate-800 bg-slate-950/50 hover:border-slate-700'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="truncate text-xs font-semibold text-slate-100">{vehicle.id}</span>
                    <span className="shrink-0 text-[10px] text-amber-300">演示车辆</span>
                  </div>
                  <p className="mt-1 truncate text-[11px] text-slate-500">{vehicle.locationLabel}</p>
                </button>
              ))}
            </div>
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
            <h2 className="text-sm font-medium text-slate-100">
              {interfacePreviewMode ? '当前车辆预览' : '连接车辆'}
            </h2>
            <label htmlFor="teleop-vehicle-suggestion" className="mt-3 block text-xs text-slate-400">
              联调建议
            </label>
            <select
              id="teleop-vehicle-suggestion"
              value={vehicleId === 'car-001' ? vehicleId : ''}
              onChange={(event) => setVehicleId(event.target.value)}
              disabled={Boolean(activeVehicleId) || isBusy}
              className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-500 disabled:opacity-60"
            >
              <option value="">选择推荐项或手动输入</option>
              <option value="car-001">car-001 · 文档中的本地联调示例</option>
            </select>
            <label htmlFor="teleop-vehicle-id" className="mt-3 block text-xs text-slate-400">
              车辆 ID（可编辑）
            </label>
            <input
              id="teleop-vehicle-id"
              value={vehicleId}
              onChange={(event) => handleVehicleSelect(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void connect()
              }}
              disabled={Boolean(activeVehicleId) || isBusy}
              autoComplete="off"
              placeholder="选择或输入已授权车辆 ID"
              className="mt-1.5 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none placeholder:text-slate-600 focus:border-sky-500 disabled:opacity-60"
            />
            <button
              type="button"
              onClick={() => {
                if (interfacePreviewMode) {
                  if (vehicleId.trim()) {
                    setPreviewVehicleId(vehicleId.trim())
                    setStatus('preview')
                    setMessage(undefined)
                  }
                } else {
                  void connect()
                }
              }}
              disabled={!vehicleId.trim() || Boolean(activeVehicleId) || isBusy}
              className="mt-3 inline-flex w-full items-center justify-center gap-2 rounded-lg bg-sky-500 px-3 py-2 text-sm font-medium text-slate-950 hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
            >
              {isBusy ? (
                <RefreshCw className="h-4 w-4 animate-spin" />
              ) : interfacePreviewMode ? (
                <Camera className="h-4 w-4" />
              ) : (
                <Radio className="h-4 w-4" />
              )}
              {isBusy ? '正在连接' : interfacePreviewMode ? '打开接管界面预览' : '连接并监看'}
            </button>
            {message && <ErrorBanner message={message} />}
            {authError && <ErrorBanner message={authError} />}
            <p className="mt-2 text-[11px] leading-5 text-slate-500">
              `car-001` 是仓库文档中的联调示例，不代表当前服务已配置、车辆在线或账号已获授权。
            </p>
          </section>

          <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
            <h2 className="flex items-center gap-2 text-sm font-medium text-slate-100">
              <Wifi className="h-4 w-4 text-slate-400" />
              会话状态
            </h2>
            <dl className="mt-3 space-y-2 text-xs">
              <StatusRow label="身份" value={operator?.Name ?? '未登录 · 界面预览'} />
              <StatusRow label="访问级别" value={viewIsPreview ? '界面预览' : '只读监看'} />
              <StatusRow label="车辆" value={viewedVehicleId ?? '未选择'} />
              <StatusRow label="视频" value={statusLabel[viewIsPreview ? 'preview' : status]} />
            </dl>
          </section>

          <section className="rounded-xl border border-amber-800/60 bg-amber-950/20 p-4">
            <h2 className="flex items-center gap-2 text-sm font-medium text-amber-100">
              <AlertTriangle className="h-4 w-4" />
              {interfacePreviewMode ? '界面预览模式' : '控制接管暂未开放'}
            </h2>
            <p className="mt-2 text-xs leading-5 text-amber-100/70">
              {interfacePreviewMode
                ? '当前通过 ?preview=1 访问。车辆列表和工作台仅用于查看界面，不发起认证或车辆连接。'
                : '当前阶段只接入身份校验和实时视频。控制会话及驾驶指令保持关闭，不会向车辆发送操作指令。'}
            </p>
          </section>
        </aside>
      </div>
    </div>
  )
}

const VideoTile: React.FC<{
  label: string
  track?: LiveKitTrack
  status: WorkbenchStatus
}> = ({ label, track, status }) => {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!track || !containerRef.current) return
    const element = track.attach()
    element.className = 'h-full w-full bg-black object-contain'
    containerRef.current.replaceChildren(element)
    return () => {
      track.detach(element)
      element.remove()
    }
  }, [track])

  return (
    <div className="relative flex min-h-[170px] items-center justify-center overflow-hidden border border-slate-800 bg-slate-950">
      {track ? (
        <div ref={containerRef} className="absolute inset-0" />
      ) : (
        <div className="flex flex-col items-center gap-2 text-slate-500">
          {status === 'connecting' ? (
            <RefreshCw className="h-5 w-5 animate-spin" />
          ) : (
            <Camera className="h-5 w-5" />
          )}
          <span className="text-xs">{status === 'waiting-video' ? '等待视频轨道' : '暂无视频'}</span>
        </div>
      )}
      <span className="absolute bottom-2 left-2 rounded bg-slate-950/80 px-2 py-1 text-[11px] text-slate-200">
        {label}
      </span>
    </div>
  )
}

const StatusRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex items-center justify-between gap-3">
    <dt className="text-slate-500">{label}</dt>
    <dd className="truncate text-right text-slate-200">{value}</dd>
  </div>
)

const ErrorBanner: React.FC<{ message: string }> = ({ message }) => (
  <div role="alert" className="mt-3 flex items-start gap-2 rounded-lg border border-rose-800/70 bg-rose-950/40 p-3 text-xs leading-5 text-rose-200">
    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
    <span>{message}</span>
  </div>
)

const WorkbenchMessage: React.FC<{ title: string; detail: string }> = ({ title, detail }) => (
  <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
    <CheckCircle2 className="h-6 w-6 animate-pulse text-sky-300" />
    <p className="text-sm text-slate-200">{title}</p>
    <p className="text-xs text-slate-500">{detail}</p>
  </div>
)

export default TeleopWorkbench
