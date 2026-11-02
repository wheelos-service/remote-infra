/**
 * @file TeleopWorkbench.tsx
 * @description 接管工作台监看界面：以视频画面为主，所有 HUD（车辆状态、小地图、网络信号等）
 * 在画面内分布，整体风格类似赛车游戏界面。
 */

import React, { useMemo, useState } from 'react'
import { Car, Maximize2, Minimize2, Wifi } from 'lucide-react'
import type { FleetMap } from '../lib/fleet-map'
import type { OverviewVehicle } from '../lib/fleet-overview'
import VehicleBev from './VehicleBev'

/**
 * 车辆档位类型。
 */
type Gear = 'P' | 'R' | 'N' | 'D' | '—'

/**
 * 接管工作台组件 Props。
 */
export interface TeleopWorkbenchProps {
  /** 当前接管的车辆编号。 */
  vehicleId: string
  /** 当前车辆档位，用于决定前视/后视画面。 */
  gear: Gear
  /** 网络信号质量等级，0–4 格。 */
  networkQuality: 0 | 1 | 2 | 3 | 4 | null
  row: OverviewVehicle
  map: FleetMap
  onBack: () => void
  onMonitor: () => void
  /** 当前车速（km/h），可选。 */
  speedKph?: number
  /** 当前电量百分比（0–100），可选。 */
  batteryPercent?: number
  /** 当前运行模式标签，例如“自动驾驶 · L4 测试”。 */
  runModeLabel?: string
  /** 当前位置简要文本，例如“深圳·测试园区 东侧路”。 */
  locationLabel?: string
}

/**
 * 接管工作台：监看模式，仅展示远程驾驶画面及 HUD 信息，不提供控制能力。
 * HUD 包含：车辆 ID、网络信号、档位/车速/电量、小地图等，全部叠加在视频内。
 */
const TeleopWorkbench: React.FC<TeleopWorkbenchProps> = ({
  vehicleId,
  gear,
  networkQuality,
  speedKph,
  batteryPercent,
  runModeLabel = '模式未知',
  locationLabel = '位置未知',
  row, map, onBack, onMonitor,
}) => {
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [failedCamera, setFailedCamera] = useState<string | null>(null)

  const isReversing = gear === 'R'

  /**
   * 当前摄像头标签与占位图配置。
   * 倒车时切换为“后视摄像头”，其余档位使用“前视摄像头”。
   */
  const cameraConfig = useMemo(
    () => ({
      label: isReversing ? '后视摄像头' : '前视摄像头',
      // 前/后视暂时共用示例图，后续可替换为真实流地址。
      src: isReversing
        ? 'https://pub-cdn.sider.ai/u/U06XHJ80209/web-coder/6add4e269654c16911758e99/resource/7460d0fd-5ab2-4e72-917f-f6eb303d8811.jpg'
        : 'https://pub-cdn.sider.ai/u/U06XHJ80209/web-coder/6add4e269654c16911758e99/resource/45bb7eca-fab5-4bb0-a5c0-1a3648353332.jpg',
    }),
    [isReversing],
  )

  /**
   * 渲染摄像头画面区域。
   * @param compact 是否为紧凑模式（用于全屏时的不同边距处理）。
   */
  const renderCameraArea = (compact: boolean) => (
    <section
      className={`flex h-full flex-col rounded-2xl border border-slate-800 bg-slate-950/90 ${
        compact ? 'p-2' : 'p-3'
      }`}
    >
      {/* 顶部标题栏：主视角说明 + LIVE 标签 */}
      <header className="mb-2 flex items-center justify-between text-xs text-slate-300">
        <div className="flex items-center gap-2">
          <span className="font-medium">主视角 · {cameraConfig.label}</span>
          <span className="rounded-full border border-amber-700 bg-amber-950/30 px-2 py-0.5 text-[11px] text-amber-200">
            <span>示例图片</span>
          </span>
        </div>
        <span className="hidden text-[11px] text-slate-500 sm:inline">
          当前为示意画面，可接入真实视频流与 HUD 叠加
        </span>
      </header>

      {/* 视频画面 + HUD 叠加层 */}
      <div className="relative min-h-[260px] flex-1 overflow-hidden rounded-xl bg-slate-950">
        {failedCamera !== cameraConfig.src && <img
          src={cameraConfig.src}
          onError={() => setFailedCamera(cameraConfig.src)}
          alt={cameraConfig.label}
          className="absolute inset-0 h-full w-full object-cover"
        />}
        {failedCamera === cameraConfig.src && <p className="absolute inset-x-0 top-24 text-center text-xs text-slate-500">示例图片不可用 · 未接入实时视频</p>}

        {/* 顶部/底部渐变叠加，提升 HUD 可读性 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b from-slate-950/90 via-slate-950/40 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-slate-950/90 via-slate-950/40 to-transparent" />

        {/* 右上角：网络信号 + 全屏按钮 */}
        <div className="absolute right-3 top-3 flex flex-col items-end gap-2 text-xs">
          <div className="flex items-center gap-2">
            <NetworkSignalIndicator quality={networkQuality} />
            <button
              type="button"
              onClick={() => setIsFullscreen((prev) => !prev)}
              className="inline-flex items-center gap-1.5 rounded-full border border-slate-700/80 bg-slate-950/80 px-2.5 py-1.5 text-[11px] text-slate-100 shadow-sm shadow-slate-950/80 transition-colors hover:border-sky-500 hover:text-sky-200 focus:outline-none focus:ring-2 focus:ring-sky-500 focus:ring-offset-2 focus:ring-offset-slate-900"
            >
              {isFullscreen ? (
                <>
                  <Minimize2 className="h-3.5 w-3.5" />
                  <span>退出全屏</span>
                </>
              ) : (
                <>
                  <Maximize2 className="h-3.5 w-3.5" />
                  <span>全屏查看</span>
                </>
              )}
            </button>
          </div>
        </div>

        {/* 底部：左侧车辆 HUD · 右侧小地图（赛车游戏式底部信息条布局） */}
        <div className="pointer-events-none absolute inset-x-3 bottom-3 flex items-end justify-between gap-3">
          {/* 左侧：车辆状态 HUD */}
          <div className="max-w-[72%] sm:max-w-[55%]">
            <StatusHud
              vehicleId={vehicleId}
              gear={gear}
              speedKph={speedKph}
              batteryPercent={batteryPercent}
              runModeLabel={runModeLabel}
              locationLabel={locationLabel}
            />
          </div>

          {/* 右侧：小地图（在底部右侧），小屏幕可根据需要隐藏或保留 */}
          <div className="pointer-events-auto hidden w-[280px] shrink-0 xl:block">
            <VehicleBev map={map} row={row} compact />
          </div>
        </div>
      </div>
    </section>
  )

  return (
    <div className="flex h-full min-h-[500px] flex-col gap-4" data-testid="remote-driving-workbench">
      {/* 顶部信息条：标题 + 运行提示 */}
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" onClick={onBack} className="rounded border border-slate-700 px-3 py-2 text-xs">返回远程驾驶列表</button>
          <h1 className="text-sm font-semibold text-slate-100">{vehicleId} · 远程驾驶工作台</h1>
          <span className="text-xs text-slate-300">{row.online ? '在线' : '离线'} · {row.control} · 监看模式</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px] text-slate-300">
            <span>Mock 数据 · 视频未接入 · 不可控制</span>
          </span>
        </div>
        <button type="button" onClick={onMonitor} className="text-xs text-sky-200">查看车辆监控</button>
      </header>
      {!row.online && <p role="status" className="text-xs text-amber-300">车辆离线，不能确认当前状态；视频未接入，控制不可用。</p>}

      {/* 主体区域：单块主视频界面（底部 HUD 左状态 + 右小地图） */}
      <main className="min-h-0 flex-1">{renderCameraArea(false)}</main>

      {/* 全屏模式遮罩：放大主画面，其余内容隐藏 */}
      {isFullscreen && (
        <div className="fixed inset-0 z-40 flex flex-col bg-slate-950/95 p-3 sm:p-4">
          <div className="mb-2 flex items-center justify-between text-xs text-slate-300">
            <div className="flex items-center gap-2">
              <span className="rounded-full border border-slate-700 bg-slate-900 px-2 py-0.5 text-[11px]">
                {vehicleId} · 全屏监看 · 不可控制
              </span>
              <span className="hidden text-slate-500 sm:inline">点击右上角按钮可退出全屏</span>
            </div>
          </div>
          <div className="min-h-0 flex-1">{renderCameraArea(true)}</div>
        </div>
      )}
    </div>
  )
}

/**
 * 网络信号强度指示器组件。
 * 使用 0–4 根信号柱展示网络质量，辅以图标和文字说明。
 */
const NetworkSignalIndicator: React.FC<{ quality: 0 | 1 | 2 | 3 | 4 | null }> = ({ quality }) => {
  if (quality === null) return <span className="rounded bg-slate-950/80 px-2 py-1 text-[11px] text-slate-400">网络质量未知 · 未测量</span>
  const bars = [1, 2, 3, 4]
  const label =
    quality === 0
      ? '无信号'
      : quality === 1
      ? '信号较弱'
      : quality === 2
      ? '信号一般'
      : quality === 3
      ? '信号良好'
      : '信号优秀'

  return (
    <div className="flex items-center gap-1.5 text-xs text-slate-200">
      <Wifi className="h-4 w-4" />
      <div className="flex items-end gap-0.5">
        {bars.map((bar) => {
          const active = quality >= bar
          const heightClass =
            bar === 1 ? 'h-1.5' : bar === 2 ? 'h-2.5' : bar === 3 ? 'h-3.5' : 'h-4.5'
          const colorClass = active ? 'bg-emerald-400' : 'bg-slate-600'
          return <div key={bar} className={`w-0.5 rounded-t-sm ${heightClass} ${colorClass}`} />
        })}
      </div>
      <span className="hidden text-[11px] text-slate-400 sm:inline">{label}</span>
    </div>
  )
}

/**
 * 底部左侧 HUD：车辆状态信息卡片。
 * 展示车辆 ID、档位、车速、电量和运行模式等核心监控信息。
 */
interface StatusHudProps {
  /** 当前车辆编号。 */
  vehicleId: string
  /** 当前档位。 */
  gear: Gear
  /** 车速（km/h）。 */
  speedKph?: number
  /** 电量百分比。 */
  batteryPercent?: number
  /** 运行模式标签。 */
  runModeLabel: string
  /** 位置文本。 */
  locationLabel: string
}

/**
 * 车辆状态 HUD 组件。
 * 在画面底部左侧集中展示车辆关键信息，类似赛车游戏 HUD。
 */
const StatusHud: React.FC<StatusHudProps> = ({
  vehicleId,
  gear,
  speedKph,
  batteryPercent,
  runModeLabel,
  locationLabel,
}) => {
  const speedText = typeof speedKph === 'number' ? `${speedKph.toFixed(1)} km/h` : '—'
  const batteryText =
    typeof batteryPercent === 'number' ? `${batteryPercent.toFixed(0)}%` : '—'
  const isLowBattery = typeof batteryPercent === 'number' ? batteryPercent <= 20 : false

  return (
    <div className="pointer-events-auto rounded-xl border border-slate-800/80 bg-slate-950/85 px-3 py-2 text-[11px] text-slate-200 shadow-lg shadow-slate-950/80 backdrop-blur-sm">
      {/* 顶部：车辆 ID + 档位 */}
      <div className="mb-1.5 flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-1.5">
          <Car className="h-3.5 w-3.5 text-slate-200" />
          <span className="text-[10px] text-slate-400">车辆</span>
          <span className="text-[11px] font-semibold text-slate-50">{vehicleId}</span>
        </div>
        <div className="inline-flex items-center gap-1 text-[10px] text-slate-300">
          <span className="text-slate-400">档位</span>
          <span className="rounded bg-slate-800/80 px-1.5 py-0.5 text-xs font-semibold text-slate-50">
            {gear}
          </span>
        </div>
      </div>

      {/* 中部：车速、电量、运行模式 */}
      <div className="grid grid-cols-2 gap-x-4 gap-y-0.5">
        <div className="flex flex-col">
          <span className="text-[10px] text-slate-400">车速</span>
          <span className="text-xs text-slate-100">{speedText}</span>
        </div>
        <div className="flex flex-col">
          <span className="text-[10px] text-slate-400">电量</span>
          <span
            className={`text-xs ${
              isLowBattery ? 'font-semibold text-amber-300' : 'text-emerald-300'
            }`}
          >
            {batteryText}
          </span>
        </div>
        <div className="col-span-2 flex flex-col">
          <span className="text-[10px] text-slate-400">运行模式</span>
          <span className="truncate text-xs text-slate-100">{runModeLabel}</span>
        </div>
      </div>

      {/* 底部：位置文本 */}
      <p className="mt-1.5 truncate text-[10px] text-slate-500">{locationLabel}</p>
    </div>
  )
}

export default TeleopWorkbench