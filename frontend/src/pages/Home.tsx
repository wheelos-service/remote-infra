import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  AlertTriangle,
  Car,
  ClipboardList,
  LogIn,
  LogOut,
  Radio,
  ShieldCheck,
} from 'lucide-react'
import { useAuth } from '../app/AuthProvider'
import { useVehicles } from '../hooks/use-vehicles'
import { createPreviewVehicles, selectedPreviewScenario } from '../lib/preview-vehicles'
import { directoryControl } from '../lib/vehicle-telemetry'
import LiveFleetPage from './LiveFleetPage'
import TeleopWorkbench from './TeleopWorkbench'
import VehicleBusinessPage from './VehicleBusinessPage'

type MainSection = 'fleet' | 'monitor' | 'drive' | 'alerts' | 'tasks'

const previewMode = new URLSearchParams(window.location.search).get('preview') === '1'

const HomePage: React.FC = () => {
  const [activeSection, setActiveSection] = useState<MainSection>('fleet')
  const [teleopActiveCount, setTeleopActiveCount] = useState(0)
  const [occupancyTick, setOccupancyTick] = useState(0)
  const auth = useAuth()
  const liveVehicles = useVehicles(previewMode ? undefined : auth.accessToken)
  const mockVehicles = useMemo(() => createPreviewVehicles(undefined, previewMode ? selectedPreviewScenario() : 'default'), [])
  const vehicles = previewMode ? mockVehicles : liveVehicles
  useEffect(() => {
    if (activeSection !== 'drive' || previewMode) return
    // Directory requests can stall beyond the occupancy snapshot's validity.
    const timer = setInterval(() => setOccupancyTick((tick) => tick + 1), 1_000)
    return () => clearInterval(timer)
  }, [activeSection])
  const workbenchVehicles = useMemo(
    () => vehicles.entries.map((entry) => ({
      id: entry.vehicle_id,
      name: entry.name || entry.vehicle_id,
      occupancy: directoryControl(
        entry,
        vehicles.requestFailed,
        performance.now(),
      ).status,
    })),
    [vehicles.entries, vehicles.requestFailed, occupancyTick],
  )

  const handleTeleopActiveChange = useCallback((activeCount: number) => {
    setTeleopActiveCount(activeCount)
  }, [])

  const handleChangeSection = (section: MainSection) => {
    if (activeSection === 'drive' && section !== 'drive' && teleopActiveCount > 0) {
      if (!window.confirm('仍有只读视频会话连接。离开将关闭全部监看面板并释放观看租约，确定继续吗？')) return
    }
    setActiveSection(section)
  }

  const handleSignOut = () => {
    if (teleopActiveCount > 0 &&
        !window.confirm('仍有只读视频会话连接。退出登录将关闭全部监看面板，确定继续吗？')) return
    auth.signOut()
  }

  let content: React.ReactNode
  if (activeSection === 'fleet' || activeSection === 'monitor') {
    content = (
      <LiveFleetPage
        mode={activeSection}
        vehicles={vehicles}
        accessToken={previewMode ? undefined : auth.accessToken}
        preview={previewMode}
      />
    )
  } else if (activeSection === 'drive') {
    content = (
      <TeleopWorkbench
        vehicles={workbenchVehicles}
        directoryReady={previewMode || vehicles.status === 'ready'}
        onActiveChange={handleTeleopActiveChange}
      />
    )
  } else {
    content = (
      <VehicleBusinessPage
        mode={activeSection}
        vehicles={vehicles}
        accessToken={previewMode ? undefined : auth.accessToken}
        preview={previewMode}
      />
    )
  }

  return (
    <div className="flex min-h-screen bg-slate-950 text-slate-50">
      <aside className="flex w-56 shrink-0 flex-col border-r border-slate-800 bg-slate-950">
        <div className="flex h-14 items-center gap-2 border-b border-slate-800 px-4">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-sky-500 text-xs font-bold text-slate-950">W</div>
          <div>
            <div className="text-sm font-semibold tracking-wide">WHEELOS</div>
            <div className="text-[10px] text-slate-500">远程驾驶平台</div>
          </div>
        </div>
        <nav className="space-y-1 px-3 py-4">
          <div className="px-2 pb-1 text-[10px] text-slate-500">运营监控</div>
          <NavButton active={activeSection === 'fleet'} onClick={() => handleChangeSection('fleet')} icon={<Car />}>车队总览</NavButton>
          <NavButton active={activeSection === 'monitor'} onClick={() => handleChangeSection('monitor')} icon={<Radio />}>车辆监控</NavButton>
          <NavButton active={activeSection === 'alerts'} onClick={() => handleChangeSection('alerts')} icon={<AlertTriangle />}>告警记录</NavButton>
          <NavButton active={activeSection === 'tasks'} onClick={() => handleChangeSection('tasks')} icon={<ClipboardList />}>任务状态</NavButton>
          <div className="px-2 pb-1 pt-5 text-[10px] text-slate-500">远程操作</div>
          <NavButton active={activeSection === 'drive'} onClick={() => handleChangeSection('drive')} icon={<Radio />}>只读监看</NavButton>
        </nav>
        <div className="mt-auto border-t border-slate-800 px-4 py-3 text-[10px] text-slate-600">
          {previewMode ? '预览模式 · 不连接真实服务' : '运营数据 · 受限查询与视频监看'}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="flex h-14 shrink-0 items-center justify-between border-b border-slate-800 bg-slate-950 px-5">
          <div className="text-xs text-slate-400">
            {previewMode ? (
              <span className="rounded-full border border-amber-700/60 bg-amber-950/30 px-2 py-1 text-amber-200">固定预览场景 · 非实时</span>
            ) : auth.operator?.Name ? (
              <span className="flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-emerald-300" />{auth.operator.Name}</span>
            ) : (
              <span>未登录</span>
            )}
          </div>
          {!previewMode && (
            <div className="flex items-center gap-2">
              {auth.accessToken ? (
                <button type="button" onClick={handleSignOut} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300 hover:border-slate-500">
                  <LogOut className="h-3.5 w-3.5" />退出
                </button>
              ) : (
                <button
                  type="button"
                  disabled={auth.loading}
                  onClick={() => void auth.signIn()}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-sky-700/70 px-3 py-1.5 text-xs text-sky-200 hover:bg-sky-950/40 disabled:opacity-50"
                >
                  <LogIn className="h-3.5 w-3.5" />登录
                </button>
              )}
              {auth.error && <span role="alert" className="max-w-xs text-[10px] text-rose-300">{auth.error}</span>}
            </div>
          )}
        </header>
        <main className="min-h-0 flex-1 overflow-hidden p-4 xl:p-6">{content}</main>
      </div>
    </div>
  )
}

const NavButton: React.FC<{
  active: boolean
  onClick(): void
  icon: React.ReactNode
  children: React.ReactNode
}> = ({ active, onClick, icon, children }) => (
  <button
    type="button"
    onClick={onClick}
    className={`flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs ${
      active ? 'bg-slate-800 text-sky-200' : 'text-slate-300 hover:bg-slate-900'
    }`}
  >
    <span className="h-4 w-4 [&>svg]:h-4 [&>svg]:w-4">{icon}</span>
    {children}
  </button>
)

export default HomePage
