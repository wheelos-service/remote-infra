import React, { useEffect, useRef, useState } from 'react'
import { bindCameraFeed, type CameraFeedTrack, type CameraFrameStats } from '../lib/camera-feed'
import { isSingleFront } from '../lib/camera-view'
import type { FrontCamera } from '../lib/camera-view'

export type { FrontCamera } from '../lib/camera-view'
export const frontCameras: { name: 'left' | 'center' | 'right'; label: string }[] = [
  { name: 'left', label: '前左' }, { name: 'center', label: '前中' }, { name: 'right', label: '前右' },
]

function CameraSlot({ name, label, track, live, failure, requireFrameCallback, onFrame, onProgress, onStats }: {
  name: FrontCamera; label: string; track?: CameraFeedTrack; live: boolean; failure?: string; requireFrameCallback?: boolean
  onFrame?: (name: FrontCamera, live: boolean, track?: CameraFeedTrack) => void
  onProgress?: (name: FrontCamera, track: CameraFeedTrack) => void
  onStats?: (name: FrontCamera, stats: CameraFrameStats) => void
}) {
  const video = useRef<HTMLVideoElement>(null)
  const onFrameRef = useRef(onFrame)
  const onStatsRef = useRef(onStats)
  const onProgressRef = useRef(onProgress)
  onFrameRef.current = onFrame
  onStatsRef.current = onStats
  onProgressRef.current = onProgress
  const [hasRendered, setHasRendered] = useState(false)
  useEffect(() => {
    setHasRendered(false)
    onFrameRef.current?.(name, false, track)
    if (!track || !video.current) return
    return bindCameraFeed(track, video.current, (value) => {
      if (value) setHasRendered(true)
      onFrameRef.current?.(name, value, track)
    }, {
      requireFrameCallback,
      onFrame: () => onProgressRef.current?.(name, track),
      onStats: stats => onStatsRef.current?.(name, stats),
    })
  }, [name, track, requireFrameCallback])
  return <section data-camera={name} className="relative flex min-h-0 min-w-0 flex-col overflow-hidden rounded-lg border border-slate-700 bg-black">
    <header className="flex justify-between gap-2 bg-slate-900 px-3 py-2 text-xs">
      <span>{label}</span><span className={live ? 'text-emerald-300' : failure ? 'text-red-300' : 'text-amber-300'}>{live ? '正在出帧' : failure ? failure : track ? '卡顿 / 等待出帧' : '等待视频'}</span>
    </header>
    <div className="relative min-h-0 flex-1">
      <video ref={video} className={`h-full w-full object-contain ${hasRendered ? '' : 'opacity-0'}`} />
      {!live && hasRendered && (
        <span className="pointer-events-none absolute right-2 top-2 rounded border border-amber-500/70 bg-amber-950/85 px-2 py-1 text-[11px] text-amber-200">
          {failure ? `相机${failure} · 不可驾驶` : requireFrameCallback ? '画面卡顿 · 暂停发令' : '画面卡顿（监看）'}
        </span>
      )}
      {!live && !hasRendered && (
        <p className="absolute inset-0 flex items-center justify-center p-3 text-center text-xs text-amber-200">
          {failure ? `相机${failure} · 不可驾驶` : track ? '等待首帧出画…' : '未接入该相机'}
        </p>
      )}
    </div>
  </section>
}

export default function ThreeCameraView({ vehicleId, tracks = {}, frames = {}, failedCameras = {}, requireFrameCallback = false, onFrame, onProgress, onStats }: {
  vehicleId: string; tracks?: Partial<Record<FrontCamera, CameraFeedTrack>>
  frames?: Partial<Record<FrontCamera, CameraFeedTrack>>
  failedCameras?: Partial<Record<FrontCamera, string>>
  requireFrameCallback?: boolean
  onFrame?: (name: FrontCamera, live: boolean, track?: CameraFeedTrack) => void
  onProgress?: (name: FrontCamera, track: CameraFeedTrack) => void
  onStats?: (name: FrontCamera, stats: CameraFrameStats) => void
}) {
  const [focused, setFocused] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)
  const singleFront = isSingleFront(tracks)
  const displayedCameras: { name: FrontCamera; label: string }[] = singleFront
    ? [{ name: 'front', label: '前视（单路）' }]
    : frontCameras
  return <section className={fullscreen ? 'fixed inset-0 z-50 flex flex-col bg-slate-950 p-4 pb-24 text-slate-100' : 'flex min-h-[300px] flex-col text-slate-100'}>
    <header className="mb-2 flex flex-wrap items-center justify-between gap-2 text-xs">
      <span>{vehicleId} · {singleFront ? '单路前视画面' : '三路独立画面 · 未拼接'} · 无后视覆盖</span>
      <div className="flex gap-2">
        <button type="button" disabled={!tracks.center} onClick={() => setFocused(value => !value)} className="rounded border border-slate-700 px-3 py-2 disabled:opacity-40">{focused ? '恢复三路布局' : '放大中间'}</button>
        <button type="button" onClick={() => setFullscreen(value => !value)} className="rounded border border-slate-700 px-3 py-2">{fullscreen ? '退出全屏' : '全屏查看'}</button>
      </div>
    </header>
    <div className={`grid min-h-[260px] flex-1 gap-1 ${singleFront ? 'grid-cols-1' : focused ? 'grid-cols-[minmax(0,2fr)_minmax(0,1fr)] grid-rows-2' : 'grid-cols-3'}`}
      style={fullscreen ? undefined : { aspectRatio: singleFront || focused ? '16 / 9' : '16 / 6' }}>
      {displayedCameras.map(camera => <div key={camera.name} className="flex min-h-0 min-w-0 [&>section]:flex-1"
        style={!singleFront && focused ? camera.name === 'center' ? { gridColumn: 1, gridRow: '1 / 3' }
          : { gridColumn: 2, gridRow: camera.name === 'left' ? 1 : 2 } : undefined}>
        <CameraSlot {...camera} track={tracks[camera.name]} live={Boolean(tracks[camera.name]) && frames[camera.name] === tracks[camera.name]} failure={failedCameras[camera.name]} requireFrameCallback={requireFrameCallback} onFrame={onFrame} onProgress={onProgress} onStats={onStats} />
      </div>)}
    </div>
  </section>
}
