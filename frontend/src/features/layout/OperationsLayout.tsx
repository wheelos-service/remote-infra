import React from 'react'
import { AlertTriangle, Camera, Car, ClipboardList, Map, Wifi } from 'lucide-react'
import { useMockFleet } from '../../app/MockFleetProvider'

export type MainSection = 'fleet' | 'monitor' | 'drive' | 'alerts' | 'tasks'

export function OperationsShell({ activeSection, onChangeSection, topBar, children }: React.PropsWithChildren<{
  activeSection: MainSection; onChangeSection: (section: MainSection) => void; topBar: React.ReactNode
}>) {
  return <div className="min-h-screen bg-slate-950 text-slate-50 flex">
    <SideNav activeSection={activeSection} onChangeSection={onChangeSection} />
    <div className="min-w-0 flex-1 flex flex-col overflow-hidden">
      {topBar}
      <main className="flex-1 p-4 xl:p-6 overflow-hidden">{children}</main>
    </div>
  </div>
}

/**
 * Props for the side navigation component.
 */
interface SideNavProps {
  /** Currently active main section. */
  activeSection: MainSection
  /** Callback when user chooses a new section. */
  onChangeSection: (section: MainSection) => void
}

/**
 * Left vertical side navigation for main sections.
 */
export const SideNav: React.FC<SideNavProps> = ({ activeSection, onChangeSection }) => {
  /**
   * Helper to compute item styles according to active state.
   */
  const itemClass = (active: boolean) =>
    [
      'flex items-center gap-2 px-4 py-2 rounded-lg cursor-pointer text-sm',
      active ? 'bg-slate-800 text-sky-200' : 'text-slate-300 hover:bg-slate-900',
    ].join(' ')

  return (
    <aside className="w-60 bg-slate-950 border-r border-slate-800 flex flex-col">
      <div className="h-14 px-4 flex items-center border-b border-slate-800">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-sky-500 flex items-center justify-center font-bold text-slate-950 text-xs">
            W
          </div>
          <div className="flex flex-col">
            <span className="font-semibold text-sm tracking-wide">WHEELOS</span>
            <span className="text-[11px] text-slate-400">远程驾驶平台</span>
          </div>
        </div>
      </div>
      <nav className="flex-1 px-3 py-4 space-y-3 text-sm">
        <div className="space-y-1">
          <div className="px-2 text-[11px] tracking-wide text-slate-500/80">运营监控</div>
          <div
            className={itemClass(activeSection === 'fleet')}
            onClick={() => onChangeSection('fleet')}
          >
            <Map className="w-4 h-4" />
            <span>车队总览</span>
          </div>
          <div
            className={itemClass(activeSection === 'monitor')}
            onClick={() => onChangeSection('monitor')}
          >
            <Camera className="w-4 h-4" />
            <span>车辆监控</span>
          </div>
        </div>

        <div className="space-y-1">
          <div className="px-2 text-[11px] tracking-wide text-slate-500/80">远程控制</div>
          <div
            className={itemClass(activeSection === 'drive')}
            onClick={() => onChangeSection('drive')}
          >
            <Car className="w-4 h-4" />
            <span>远程驾驶</span>
          </div>
        </div>

        <div className="space-y-1 pt-3 border-t border-slate-800">
          <div className="px-2 text-[11px] tracking-wide text-slate-500/80">异常处置</div>
          <div
            className={itemClass(activeSection === 'alerts')}
            onClick={() => onChangeSection('alerts')}
          >
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <span>告警中心</span>
          </div>
        </div>

        <div className="space-y-1">
          <div className="px-2 text-[11px] tracking-wide text-slate-500/80">任务调度</div>
          <div className={itemClass(activeSection === 'tasks')} onClick={() => onChangeSection('tasks')}>
            <ClipboardList className="w-4 h-4" />
            <span>任务管理</span>
          </div>
        </div>
      </nav>
    </aside>
  )
}

/**
 * Top bar with location, time and operator information.
 */
export const TopBar: React.FC = () => {
  const mock = useMockFleet()
  return (
    <header className="h-14 border-b border-slate-800 flex items-center justify-between px-4 xl:px-6">
      <div className="flex items-center gap-4 text-sm">
        <span className="text-slate-400">{mock.map?.version ?? '正在加载地图'}</span>
        <span className="inline-flex items-center gap-1 text-emerald-400 text-xs bg-emerald-950/40 px-2 py-0.5 rounded-full border border-emerald-700/60">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
          {mock.error ? '数据不可用' : mock.map ? 'Mock 更新中' : '加载中'}
        </span>
        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-slate-900 border border-slate-700 text-slate-300">
          多车 Mock · 非真实车辆
        </span>
      </div>
      <div className="flex items-center gap-4 text-xs text-slate-400">
        <a href={`${window.location.pathname}#/?page=monitor`} className="text-sky-200">退出预览并登录平台</a>
        <a href={`${window.location.pathname}#/admin`} className="text-sky-200">组织管理（非预览）</a>
        <span>{mock.vehicles.updatedAtWallMs ? new Date(mock.vehicles.updatedAtWallMs).toLocaleString('zh-CN', { hour12: false }) : '等待数据'}</span>
        <div className="flex items-center gap-1">
          <Wifi className="w-3 h-3" />
          <span>{mock.error ? '加载失败' : '本地合成数据'}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center text-[10px]">
            OP
          </div>
          <span>mock-observer</span>
        </div>
      </div>
    </header>
  )
}
