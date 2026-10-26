/**
 * @file Home.tsx
 * @description Main dashboard page for an autonomous fleet monitoring and remote driving platform.
 *              Contains fleet overview, vehicle monitoring hub, remote teleoperation workspace,
 *              alert center and task management center.
 */

import React, { useMemo, useState } from 'react'
import {
  Activity,
  AlertTriangle,
  Camera,
  Car,
  ClipboardList,
  Clock,
  Compass,
  FileText,
  Gauge,
  LogIn,
  LogOut,
  Map,
  Wifi,
  Zap,
} from 'lucide-react'
import { useAuth } from '../app/AuthProvider'
import TeleopWorkbench from './TeleopWorkbench'

/**
 * Vehicle driving or connection status types.
 */
type VehicleStatus = 'AUTONOMOUS' | 'IDLE' | 'ALARM' | 'OFFLINE'

/**
 * Summary information for a vehicle used in fleet overview and list.
 */
interface VehicleSummary {
  /** Unique vehicle identifier. */
  id: string
  /** Short human readable name. */
  name: string
  /** Current high-level status. */
  status: VehicleStatus
  /** Current speed in km/h. */
  speedKmh: number
  /** Last update timestamp as display string. */
  lastUpdate: string
  /** Short description of current location. */
  locationLabel: string
}

/**
 * Supported main page sections in the dashboard.
 */
type MainSection = 'fleet' | 'monitor' | 'drive' | 'alerts' | 'tasks'

/**
 * Alert severity levels.
 */
type AlertSeverity = 'critical' | 'warning' | 'info'

/**
 * Alert lifecycle status.
 */
type AlertStatus = 'open' | 'in-progress' | 'closed'

/**
 * Alert record describing an autonomous-driving incident and its handling.
 */
interface AlertRecord {
  id: string
  time: string
  vehicleId: string
  title: string
  severity: AlertSeverity
  status: AlertStatus
  location: string
  description: string
  impact: string
  cause: string
  resolution: string
  followUp: string
}

/**
 * Task lifecycle status.
 */
type TaskStatus = 'draft' | 'scheduled' | 'running' | 'completed' | 'canceled'

/**
 * Mission / job order to be dispatched to vehicles.
 */
interface TaskRecord {
  id: string
  name: string
  vehicleId: string
  type: string
  priority: '高' | '中' | '低'
  status: TaskStatus
  plannedStart: string
  createdBy: string
  createdAt: string
  from: string
  to: string
}

/**
 * Top-level home page component. Acts as the shell for all views.
 */
const HomePage: React.FC = () => {
  const [activeSection, setActiveSection] = useState<MainSection>('fleet')
  const [selectedVehicleId, setSelectedVehicleId] = useState<string>('AV-012')
  const [teleopActive, setTeleopActive] = useState(false)
  const auth = useAuth()
  /** Current view mode in the vehicle monitoring module. */
  const [monitorMode, setMonitorMode] = useState<'list' | 'detail'>('list')

  const vehicles: VehicleSummary[] = useMemo(
    () => [
      {
        id: 'AV-012',
        name: '测试园区 · 东侧路',
        status: 'AUTONOMOUS',
        speedKmh: 32,
        lastUpdate: '08:21:30',
        locationLabel: '测试园区 · 东侧路',
      },
      {
        id: 'AV-008',
        name: '测试园区 · 西侧路',
        status: 'AUTONOMOUS',
        speedKmh: 28,
        lastUpdate: '08:21:24',
        locationLabel: '测试园区 · 西侧路',
      },
      {
        id: 'AV-021',
        name: '测试园区 · 生产车间',
        status: 'IDLE',
        speedKmh: 0,
        lastUpdate: '08:21:12',
        locationLabel: '生产车间 · 装载区',
      },
      {
        id: 'AV-006',
        name: '测试园区 · 物流中心',
        status: 'AUTONOMOUS',
        speedKmh: 25,
        lastUpdate: '08:21:08',
        locationLabel: '物流中心 · 北门',
      },
      {
        id: 'AV-019',
        name: '测试园区 · 南二路',
        status: 'ALARM',
        speedKmh: 12,
        lastUpdate: '08:20:53',
        locationLabel: '南二路 · 交叉口',
      },
    ],
    [],
  )

  const selectedVehicle = useMemo(
    () => vehicles.find((v) => v.id === selectedVehicleId) ?? vehicles[0],
    [selectedVehicleId, vehicles],
  )

  /**
   * Handles selecting a vehicle from either the map or list.
   * Optionally switches to the monitor detail view.
   */
  const handleSelectVehicle = (id: string, goToMonitor = false) => {
    setSelectedVehicleId(id)
    if (goToMonitor) {
      setActiveSection('monitor')
      setMonitorMode('detail')
    }
  }

  /**
   * Handles switching main sections from the side navigation.
   * Resets monitor mode to list when entering vehicle monitoring.
   */
  const handleChangeSection = (section: MainSection) => {
    if (activeSection === 'drive' && section !== 'drive' && teleopActive) {
      if (!window.confirm('远程监看仍在连接。确定离开并断开当前视频会话吗？')) return
    }
    setActiveSection(section)
    if (section === 'monitor') {
      setMonitorMode('list')
    }
  }

  const handleSignOut = () => {
    if (teleopActive && !window.confirm('远程视频仍在连接。确定退出并断开当前会话吗？')) return
    auth.signOut()
  }

  let content: React.ReactNode
  if (activeSection === 'fleet') {
    content = (
      <FleetOverview
        vehicles={vehicles}
        selectedVehicleId={selectedVehicle.id}
        onSelectVehicle={handleSelectVehicle}
      />
    )
  } else if (activeSection === 'monitor') {
    content = (
      <VehicleMonitorSection
        vehicles={vehicles}
        selectedVehicle={selectedVehicle}
        mode={monitorMode}
        onModeChange={setMonitorMode}
        onSelectVehicle={handleSelectVehicle}
      />
    )
  } else if (activeSection === 'drive') {
    content = <TeleopWorkbench vehicles={vehicles} onActiveChange={setTeleopActive} />
  } else if (activeSection === 'alerts') {
    content = <AlertCenter />
  } else {
    content = <TaskCenter vehicles={vehicles} />
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 flex">
      <SideNav activeSection={activeSection} onChangeSection={handleChangeSection} />
      <div className="flex-1 flex flex-col overflow-hidden">
        <TopBar onSignOut={handleSignOut} teleopActive={teleopActive} />
        <main className="flex-1 p-4 xl:p-6 overflow-hidden">{content}</main>
      </div>
    </div>
  )
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
const SideNav: React.FC<SideNavProps> = ({ activeSection, onChangeSection }) => {
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
            <span>接管工作台</span>
          </div>
        </div>

        <div className="space-y-1 pt-3 border-t border-slate-800">
          <div className="px-2 text-[11px] tracking-wide text-slate-500/80">异常处置</div>
          <div
            className={itemClass(activeSection === 'alerts')}
            onClick={() => onChangeSection('alerts')}
          >
            <AlertTriangle className="w-4 h-4 text-amber-400" />
            <span>告警事件</span>
          </div>
        </div>

        <div className="space-y-1">
          <div className="px-2 text-[11px] tracking-wide text-slate-500/80">任务调度</div>
          <div
            className={itemClass(activeSection === 'tasks')}
            onClick={() => onChangeSection('tasks')}
          >
            <ClipboardList className="w-4 h-4" />
            <span>任务管理</span>
          </div>
        </div>
      </nav>
      <div className="px-4 py-3 border-t border-slate-800 text-[11px] text-slate-500">
        演示数据 · 非实时
      </div>
    </aside>
  )
}

/**
 * Top bar with location, time and operator information.
 */
const TopBar: React.FC<{ onSignOut: () => void; teleopActive: boolean }> = ({
  onSignOut,
  teleopActive,
}) => {
  const auth = useAuth()

  return (
    <header className="h-14 border-b border-slate-800 flex items-center justify-between px-4 xl:px-6">
      <div className="flex items-center gap-4 text-sm">
        <span className="text-slate-200">运维管理平台</span>
        <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-slate-900 border border-slate-700 text-slate-300">
          部分模块为演示
        </span>
      </div>
      <div className="flex items-center gap-4 text-xs text-slate-400">
        {auth.error && (
          <span role="alert" className="max-w-sm truncate text-rose-300" title={auth.error}>
            {auth.error}
          </span>
        )}
        {auth.loading ? (
          <span>正在校验登录状态…</span>
        ) : auth.operator ? (
          <>
            <span className="inline-flex items-center gap-2 text-slate-200">
              <span className="flex h-6 w-6 items-center justify-center rounded-full bg-slate-700 text-[10px]">
                {auth.operator.Name?.slice(0, 2).toUpperCase()}
              </span>
              <span>{auth.operator.Name}</span>
              {auth.operator.Organization && (
                <span className="text-slate-500">{auth.operator.Organization}</span>
              )}
            </span>
            <button
              type="button"
              onClick={onSignOut}
              title={teleopActive ? '退出并断开当前视频会话' : '退出登录'}
              className="inline-flex items-center gap-1 rounded-md border border-slate-700 px-2 py-1 text-slate-300 hover:border-slate-500"
            >
              <LogOut className="h-3.5 w-3.5" />
              退出
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void auth.signIn()}
              className="inline-flex items-center gap-1 rounded-md bg-sky-500 px-2.5 py-1.5 font-medium text-slate-950 hover:bg-sky-400"
            >
              <LogIn className="h-3.5 w-3.5" />
              企业账号登录
            </button>
            {auth.isDevLoginAvailable && (
              <button
                type="button"
                onClick={() => void auth.signInWithDevToken()}
                className="rounded-md border border-slate-700 px-2 py-1 text-slate-300 hover:border-slate-500"
              >
                本地开发登录
              </button>
            )}
          </>
        )}
      </div>
    </header>
  )
}

/**
 * Props for the fleet overview section.
 */
interface FleetOverviewProps {
  /** All vehicles to be shown. */
  vehicles: VehicleSummary[]
  /** Currently selected vehicle id. */
  selectedVehicleId: string
  /**
   * Handler when user clicks a vehicle.
   * @param id Vehicle identifier.
   * @param goToMonitor Whether to immediately switch to monitor view.
   */
  onSelectVehicle: (id: string, goToMonitor?: boolean) => void
}

/**
 * Fleet overview content with summary stats, map and vehicle list.
 */
const FleetOverview: React.FC<FleetOverviewProps> = ({
  vehicles,
  selectedVehicleId,
  onSelectVehicle,
}) => {
  const online = vehicles.filter((v) => v.status !== 'OFFLINE').length
  const autonomous = vehicles.filter((v) => v.status === 'AUTONOMOUS').length
  const manual = vehicles.filter((v) => v.status === 'IDLE').length
  const alarms = vehicles.filter((v) => v.status === 'ALARM').length

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <SummaryCard
          icon={<Car className="w-4 h-4 text-emerald-400" />}
          label="在线车辆"
          value={`${online} / ${vehicles.length}`}
          pillLabel="Online"
        />
        <SummaryCard
          icon={<Gauge className="w-4 h-4 text-sky-400" />}
          label="自动驾驶"
          value={autonomous.toString()}
          pillLabel="Autonomous"
        />
        <SummaryCard
          icon={<Activity className="w-4 h-4 text-amber-300" />}
          label="人工接管"
          value={manual.toString()}
          pillLabel="Manual"
        />
        <SummaryCard
          icon={<AlertTriangle className="w-4 h-4 text-red-400" />}
          label="告警事件"
          value={alarms.toString()}
          pillLabel="Alarms"
        />
      </div>

      {/* Map + vehicle list */}
      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)] gap-4">
        <MapPanel vehicles={vehicles} selectedVehicleId={selectedVehicleId} onSelect={onSelectVehicle} />
        <VehicleListPanel
          vehicles={vehicles}
          selectedVehicleId={selectedVehicleId}
          onSelect={onSelectVehicle}
        />
      </div>
    </div>
  )
}

/**
 * Props for a small summary stat card.
 */
interface SummaryCardProps {
  /** Left icon element. */
  icon: React.ReactNode
  /** Text label. */
  label: string
  /** Main value string. */
  value: string
  /** Small pill label in the corner. */
  pillLabel: string
}

/**
 * Small card used in the dashboard header for key metrics.
 */
const SummaryCard: React.FC<SummaryCardProps> = ({ icon, label, value, pillLabel }) => {
  return (
    <div className="bg-slate-900/70 border border-slate-800 rounded-xl px-4 py-3 flex items-center justify-between">
      <div className="flex items-center gap-3">
        <div className="w-9 h-9 rounded-lg bg-slate-800/80 flex items-center justify-center">
          {icon}
        </div>
        <div className="flex flex-col">
          <span className="text-xs text-slate-400">{label}</span>
          <span className="text-lg font-semibold">{value}</span>
        </div>
      </div>
      <span className="text-[10px] px-2 py-0.5 rounded-full border border-slate-700 text-slate-300">
        {pillLabel}
      </span>
    </div>
  )
}

/**
 * Props for the fleet map panel.
 */
interface MapPanelProps {
  /** Vehicles to render as markers. */
  vehicles: VehicleSummary[]
  /** Id of current selection. */
  selectedVehicleId: string
  /** Handler when selecting a vehicle. */
  onSelect: (id: string, goToMonitor?: boolean) => void
}

/**
 * Map panel showing a static map background with vehicle markers.
 * Uses a placeholder image; can later be replaced with a real map SDK.
 */
const MapPanel: React.FC<MapPanelProps> = ({ vehicles, selectedVehicleId, onSelect }) => {
  /**
   * Returns Tailwind classes for a vehicle marker according to status.
   */
  const markerClass = (status: VehicleStatus, selected: boolean) => {
    const base =
      'w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-semibold cursor-pointer border'
    const stateColor =
      status === 'AUTONOMOUS'
        ? 'bg-emerald-500 border-emerald-300'
        : status === 'IDLE'
        ? 'bg-amber-400 border-amber-200'
        : status === 'ALARM'
        ? 'bg-red-500 border-red-300'
        : 'bg-slate-500 border-slate-300'
    const selectedRing = selected
      ? ' ring-2 ring-offset-2 ring-offset-slate-900 ring-sky-400'
      : ''
    return [base, stateColor, selectedRing].join(' ')
  }

  return (
    <section className="bg-slate-900/70 border border-slate-800 rounded-xl p-3 flex flex-col min-h-[260px]">
      <div className="flex items-center justify-between mb-2 text-xs text-slate-300">
        <div className="flex items-center gap-2">
          <span className="font-medium">道路图</span>
          <span className="px-2 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700">
            实时位置
          </span>
        </div>
        <div className="flex items-center gap-3">
          <button className="flex items-center gap-1 text-slate-300 hover:text-sky-300">
            <Compass className="w-3 h-3" />
            <span>居中到车队</span>
          </button>
          <div className="flex items-center gap-1 text-slate-500">
            <div className="w-2 h-2 rounded-full bg-emerald-400" />
            <span className="text-[11px]">自动驾驶</span>
          </div>
          <div className="flex items-center gap-1 text-slate-500">
            <div className="w-2 h-2 rounded-full bg-amber-400" />
            <span className="text-[11px]">待命</span>
          </div>
          <div className="flex items-center gap-1 text-slate-500">
            <div className="w-2 h-2 rounded-full bg-red-500" />
            <span className="text-[11px]">告警</span>
          </div>
        </div>
      </div>
      <div className="relative flex-1 rounded-lg overflow-hidden bg-slate-950">
        {/* Placeholder map image */}
        <img
          src="https://pub-cdn.sider.ai/u/U06XHJ80209/web-coder/6add4e269654c16911758e99/resource/3aea9af3-0d7d-4226-aced-31db46d2ce55.png"
          alt="Test park map"
          className="absolute inset-0 w-full h-full object-cover opacity-80"
        />
        {/* Subtle overlay for contrast */}
        <div className="absolute inset-0 bg-slate-950/40" />
        {/* Vehicle markers (positions are approximate & static for placeholder) */}
        <div className="absolute inset-0">
          {/* Hard-coded marker positions in percentage to simulate layout */}
          {vehicles.map((v, index) => {
            const positions = [
              { top: '55%', left: '50%' }, // AV-012
              { top: '40%', left: '25%' }, // AV-008
              { top: '20%', left: '70%' }, // AV-021
              { top: '65%', left: '35%' }, // AV-006
              { top: '70%', left: '60%' }, // AV-019
            ]
            const pos = positions[index] ?? { top: '50%', left: '50%' }
            const isSelected = v.id === selectedVehicleId
            return (
              <button
                key={v.id}
                type="button"
                style={{ top: pos.top, left: pos.left }}
                className="absolute -translate-x-1/2 -translate-y-1/2 focus:outline-none"
                onClick={() => onSelect(v.id, true)}
              >
                <div className={markerClass(v.status, isSelected)} title={v.id}>
                  <Car className="w-3 h-3 text-slate-950" />
                </div>
                <div className="mt-1 px-1.5 py-0.5 rounded bg-slate-900/90 text-[10px] text-slate-100 border border-slate-700">
                  {v.id}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    </section>
  )
}

/**
 * Props for the vehicle list panel in fleet overview.
 */
interface VehicleListPanelProps {
  /** Vehicles to show. */
  vehicles: VehicleSummary[]
  /** Currently selected vehicle id. */
  selectedVehicleId: string
  /** Handler when selecting a vehicle. */
  onSelect: (id: string, goToMonitor?: boolean) => void
}

/**
 * Right-hand side panel listing vehicles that require special attention.
 * This replaces a full vehicle roster with a focused "need attention" list.
 */
const VehicleListPanel: React.FC<VehicleListPanelProps> = ({
  vehicles,
  selectedVehicleId,
  onSelect,
}) => {
  /**
   * Pick vehicles that require special attention.
   * For now: ALARM and OFFLINE, ordered by severity.
   */
  const attentionVehicles = vehicles
    .filter((v) => v.status === 'ALARM' || v.status === 'OFFLINE')
    .sort((a, b) => {
      const score = (status: VehicleStatus) => {
        if (status === 'ALARM') return 3
        if (status === 'OFFLINE') return 2
        if (status === 'IDLE') return 1
        return 0
      }
      return score(b.status) - score(a.status)
    })

  const hasAttention = attentionVehicles.length > 0

  return (
    <section className="bg-slate-900/70 border border-slate-800 rounded-xl p-3 flex flex-col min-h-[260px]">
      <div className="flex items-center justify-between mb-3">
        <div className="flex flex-col">
          <span className="text-xs text-slate-400">需关注车辆</span>
          <span className="text-sm font-medium">告警 / 离线优先</span>
        </div>
        <div className="flex items-center gap-1 text-[11px] text-slate-500">
          <span className="px-2 py-0.5 rounded-full bg-slate-900 border border-slate-700 text-slate-300">
            自动聚焦异常车辆
          </span>
        </div>
      </div>
      <div className="mb-2">
        <div className="relative">
          <input
            className="w-full rounded-lg bg-slate-950 border border-slate-800 px-3 py-1.5 text-xs placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
            placeholder="按车辆编号 / 位置快速筛选...（示例）"
          />
          <span className="absolute right-2 top-1.5 text-[11px] text-slate-500">Q</span>
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto space-y-1 pr-1">
        {hasAttention ? (
          attentionVehicles.map((v) => (
            <button
              key={v.id}
              type="button"
              onClick={() => onSelect(v.id, true)}
              className={[
                'w-full text-left rounded-lg px-3 py-2 flex items-center gap-3 border',
                v.id === selectedVehicleId
                  ? 'bg-slate-800/80 border-sky-500/60'
                  : 'bg-slate-950/40 border-slate-800 hover:border-slate-700',
              ].join(' ')}
            >
              <VehicleStatusIcon status={v.status} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold text-slate-100">{v.id}</span>
                  <span className="text-[11px] text-slate-500">{v.lastUpdate}</span>
                </div>
                <div className="flex items-center justify-between mt-0.5">
                  <span className="text-[11px] text-slate-400 truncate">
                    {v.locationLabel}
                  </span>
                  <span className="text-[11px] text-slate-300">
                    {renderStatusLabel(v.status)} · {v.speedKmh} km/h
                  </span>
                </div>
              </div>
            </button>
          ))
        ) : (
          <div className="px-2 py-4 text-center text-[11px] text-slate-500">
            当前无告警或离线车辆，所有车辆运行正常。
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * Renders a colored vehicle status icon used in lists.
 */
const VehicleStatusIcon: React.FC<{ status: VehicleStatus }> = ({ status }) => {
  const colorClass =
    status === 'AUTONOMOUS'
      ? 'bg-emerald-500'
      : status === 'IDLE'
      ? 'bg-amber-400'
      : status === 'ALARM'
      ? 'bg-red-500'
      : 'bg-slate-500'
  return (
    <div
      className={`w-8 h-8 rounded-full flex items-center justify-center text-slate-950 ${colorClass}`}
    >
      <Car className="w-4 h-4" />
    </div>
  )
}

/**
 * Returns a short human readable status label string.
 */
const renderStatusLabel = (status: VehicleStatus): string => {
  switch (status) {
    case 'AUTONOMOUS':
      return '自动驾驶'
    case 'IDLE':
      return '待命'
    case 'ALARM':
      return '告警'
    case 'OFFLINE':
    default:
      return '离线'
  }
}

/**
 * Props for the vehicle monitoring section shell.
 */
interface VehicleMonitorSectionProps {
  /** All vehicles available for monitoring. */
  vehicles: VehicleSummary[]
  /** Currently selected vehicle summary. */
  selectedVehicle: VehicleSummary
  /** Current monitor mode: list hub or detail object page. */
  mode: 'list' | 'detail'
  /** Handler for changing monitor mode. */
  onModeChange: (mode: 'list' | 'detail') => void
  /** Handler when a vehicle is selected. */
  onSelectVehicle: (id: string, goToMonitor?: boolean) => void
}

/**
 * Vehicle monitoring module: list + multi-view hub + vehicle detail object page.
 */
const VehicleMonitorSection: React.FC<VehicleMonitorSectionProps> = ({
  vehicles,
  selectedVehicle,
  mode,
  onModeChange,
  onSelectVehicle,
}) => {
  const [tab, setTab] = useState<'list' | 'multi'>('list')

  if (mode === 'detail') {
    return (
      <VehicleDetailPage
        vehicle={selectedVehicle}
        onBackToList={() => onModeChange('list')}
      />
    )
  }

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold text-slate-100">车辆监控</h1>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-900 border border-slate-700 text-[11px] text-slate-300">
              <Car className="w-3 h-3" />
              全量车队运行花名册
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            浏览全部车辆的状态、运行模式与告警，选择车辆进入详情页进行深入排查。
          </p>
        </div>
      </div>

      {/* Secondary tabs: list vs multi-monitor */}
      <div className="border-b border-slate-800 text-xs">
        <div className="inline-flex rounded-full bg-slate-900 border border-slate-800 p-0.5">
          <button
            type="button"
            onClick={() => setTab('list')}
            className={[
              'px-3 py-1 rounded-full',
              tab === 'list' ? 'bg-sky-600 text-slate-950' : 'text-slate-300',
            ].join(' ')}
          >
            车辆列表
          </button>
          <button
            type="button"
            onClick={() => setTab('multi')}
            className={[
              'px-3 py-1 rounded-full',
              tab === 'multi' ? 'bg-sky-600 text-slate-950' : 'text-slate-300',
            ].join(' ')}
          >
            多车监看
          </button>
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {tab === 'list' ? (
          <VehicleTableView
            vehicles={vehicles}
            selectedVehicleId={selectedVehicle.id}
            onSelectVehicle={(id) => {
              onSelectVehicle(id, true)
              onModeChange('detail')
            }}
          />
        ) : (
          <MultiVehicleMonitorGrid vehicles={vehicles} />
        )}
      </div>
    </div>
  )
}

/**
 * Props for vehicle table view inside vehicle monitoring.
 */
interface VehicleTableViewProps {
  /** Vehicles to display in the table. */
  vehicles: VehicleSummary[]
  /** Currently selected vehicle id. */
  selectedVehicleId: string
  /** Handler when clicking a row to enter detail. */
  onSelectVehicle: (id: string) => void
}

/**
 * Tab content: full vehicle roster in a compact table-like list.
 */
const VehicleTableView: React.FC<VehicleTableViewProps> = ({
  vehicles,
  selectedVehicleId,
  onSelectVehicle,
}) => {
  return (
    <section className="h-full bg-slate-900/70 border border-slate-800 rounded-xl flex flex-col">
      <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between text-xs text-slate-300">
        <span className="font-medium">车辆列表</span>
        <span className="text-slate-500">共 {vehicles.length} 辆 · 点击行进入车辆详情</span>
      </div>
      <div className="grid grid-cols-[minmax(0,1.6fr)_minmax(0,1.1fr)_minmax(0,1fr)] px-3 py-1 text-[11px] text-slate-500 border-b border-slate-800/80">
        <span>车辆与位置</span>
        <span>状态 / 模式</span>
        <span className="text-right">速度 / 最后更新</span>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {vehicles.map((v) => {
          const isSelected = v.id === selectedVehicleId
          return (
            <button
              key={v.id}
              type="button"
              onClick={() => onSelectVehicle(v.id)}
              className={[
                'w-full px-3 py-2 text-left flex items-center gap-3 border-b border-slate-800/80 hover:bg-slate-900',
                isSelected ? 'bg-slate-900/80' : '',
              ].join(' ')}
            >
              <div className="flex items-center gap-2 min-w-0 flex-[1.6]">
                <VehicleStatusIcon status={v.status} />
                <div className="flex flex-col min-w-0">
                  <span className="text-xs font-semibold text-slate-100">{v.id}</span>
                  <span className="text-[11px] text-slate-500 truncate">{v.locationLabel}</span>
                </div>
              </div>
              <div className="flex flex-col flex-[1.1] text-[11px] text-slate-300">
                <span>{renderStatusLabel(v.status)}</span>
                <span className="text-slate-500">运行模式 · 自动驾驶（示例）</span>
              </div>
              <div className="ml-auto flex flex-col items-end flex-1 text-[11px] text-slate-300">
                <span>{v.speedKmh} km/h</span>
                <span className="text-slate-500">最后更新 {v.lastUpdate}</span>
              </div>
            </button>
          )
        })}
      </div>
    </section>
  )
}

/**
 * Props for the multi-vehicle monitor grid.
 */
interface MultiVehicleMonitorGridProps {
  /** Vehicles to display as tiles. */
  vehicles: VehicleSummary[]
}

/**
 * Tab content: simple 2x2 / 3x3 grid for monitoring multiple vehicles at once.
 * Currently uses static camera placeholders.
 */
const MultiVehicleMonitorGrid: React.FC<MultiVehicleMonitorGridProps> = ({ vehicles }) => {
  const topVehicles = vehicles.slice(0, 4)

  return (
    <section className="h-full bg-slate-900/70 border border-slate-800 rounded-xl p-3 flex flex-col">
      <div className="flex items-center justify-between mb-2 text-xs text-slate-300">
        <span className="font-medium">多车监看（示例）</span>
        <span className="text-[11px] text-slate-500">
          适合值守员同时关注多辆重点车辆，后续可接入真实多路视频。
        </span>
      </div>
      <div className="flex-1 min-h-0 grid grid-cols-1 md:grid-cols-2 gap-3">
        {topVehicles.map((v) => (
          <div
            key={v.id}
            className="relative rounded-lg overflow-hidden bg-slate-950 border border-slate-800"
          >
            <img
              src="https://pub-cdn.sider.ai/u/U06XHJ80209/web-coder/6add4e269654c16911758e99/resource/9fffc6cd-027d-472a-b2f1-f93d7593b500.jpg"
              alt={`Vehicle ${v.id} front view`}
              className="absolute inset-0 w-full h-full object-cover"
            />
            <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-slate-950/90 via-slate-950/40 to-transparent" />
            <div className="absolute inset-x-2 top-2 flex items-center justify-between text-[11px] text-slate-100">
              <div className="flex items-center gap-2">
                <span className="px-1.5 py-0.5 rounded bg-slate-900/90 border border-slate-700 text-xs font-semibold">
                  {v.id}
                </span>
                <span className="hidden sm:inline text-slate-300 truncate max-w-[140px]">
                  {v.locationLabel}
                </span>
              </div>
              <div className="flex items-center gap-2 text-slate-200">
                <span>{v.speedKmh} km/h</span>
                <span
                  className={[
                    'px-1.5 py-0.5 rounded-full border',
                    v.status === 'ALARM'
                      ? 'border-red-500/70 bg-red-900/40 text-red-200'
                      : 'border-emerald-500/70 bg-emerald-900/40 text-emerald-200',
                  ].join(' ')}
                >
                  {renderStatusLabel(v.status)}
                </span>
              </div>
            </div>
          </div>
        ))}
        {topVehicles.length === 0 && (
          <div className="flex items-center justify-center text-xs text-slate-500 border border-dashed border-slate-700 rounded-lg">
            当前暂无在线车辆可用于多车监看。
          </div>
        )}
      </div>
    </section>
  )
}

/**
 * Props for the vehicle detail page (object page).
 */
interface VehicleDetailPageProps {
  /** Vehicle whose detail is being inspected. */
  vehicle: VehicleSummary
  /** Callback returning to the vehicle list hub. */
  onBackToList: () => void
}

/**
 * Vehicle detail page acting as hub for a single vehicle.
 * Contains top fixed identity bar and secondary tabs.
 */
const VehicleDetailPage: React.FC<VehicleDetailPageProps> = ({ vehicle, onBackToList }) => {
  const [activeTab, setActiveTab] = useState<
    'realtime' | 'diagnosis' | 'tasks' | 'events' | 'replay' | 'profile'
  >('realtime')

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Breadcrumb + fixed key info */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 text-sm">
          <button
            type="button"
            onClick={onBackToList}
            className="px-2 py-1 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-300 hover:border-slate-700"
          >
            车辆监控
          </button>
          <span className="text-slate-500">/</span>
          <span className="font-semibold text-slate-100">{vehicle.id}</span>
          <span className="text-xs text-slate-400">{vehicle.name}</span>
          <span className="inline-flex items-center gap-1 text-emerald-300 text-xs bg-emerald-950/40 px-2 py-0.5 rounded-full border border-emerald-700/60">
            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
            自动驾驶中（示例）
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs text-slate-400">
          <div className="flex items-center gap-1">
            <Gauge className="w-3 h-3" />
            <span>车速</span>
            <span className="text-slate-100 font-semibold">
              {vehicle.speedKmh} km/h
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Wifi className="w-3 h-3" />
            <span>链路</span>
            <span className="text-emerald-400">正常</span>
          </div>
          <div className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            <span>数据时间</span>
            <span className="text-slate-300">{vehicle.lastUpdate}</span>
          </div>
        </div>
      </div>

      {/* Detail tabs */}
      <div className="border-b border-slate-800 text-xs">
        <div className="inline-flex rounded-full bg-slate-900 border border-slate-800 p-0.5">
          {[
            { key: 'realtime' as const, label: '实时' },
            { key: 'diagnosis' as const, label: '诊断' },
            { key: 'tasks' as const, label: '任务' },
            { key: 'events' as const, label: '事件' },
            { key: 'replay' as const, label: '回放' },
            { key: 'profile' as const, label: '档案' },
          ].map((item) => (
            <button
              key={item.key}
              type="button"
              onClick={() => setActiveTab(item.key)}
              className={[
                'px-2.5 py-1 rounded-full',
                activeTab === item.key ? 'bg-sky-600 text-slate-950' : 'text-slate-300',
              ].join(' ')}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 min-h-0">
        {activeTab === 'realtime' && <VehicleMonitorRealtimeTab vehicle={vehicle} />}
        {activeTab === 'diagnosis' && (
          <PlaceholderSection
            title="诊断（示例占位）"
            description="展示模块健康矩阵、频率/时延曲线和定位细节等内容，帮助快速定位问题来源。"
          />
        )}
        {activeTab === 'tasks' && (
          <PlaceholderSection
            title="任务"
            description="展示当前任务进度和历史任务列表，支持跳转到具体任务详情页。"
          />
        )}
        {activeTab === 'events' && (
          <PlaceholderSection
            title="事件"
            description="聚合该车辆的告警事件与接管记录，用于跟踪问题闭环情况。"
          />
        )}
        {activeTab === 'replay' && (
          <PlaceholderSection
            title="回放"
            description="按时间轴回放视频、轨迹与关键状态，支持从事件时间点快速跳入。"
          />
        )}
        {activeTab === 'profile' && (
          <PlaceholderSection
            title="车辆档案"
            description="展示车辆配置、软件版本和传感器标定信息（可与运维管理模块打通）。"
          />
        )}
      </div>
    </div>
  )
}

/**
 * Simple placeholder card used for tabs whose detailed content is not implemented yet.
 */
const PlaceholderSection: React.FC<{ title: string; description: string }> = ({
  title,
  description,
}) => {
  return (
    <section className="h-full bg-slate-900/70 border border-dashed border-slate-700 rounded-xl p-4 flex flex-col gap-2 text-xs text-slate-300">
      <div className="text-sm font-medium text-slate-100">{title}</div>
      <p className="max-w-2xl leading-relaxed text-slate-400">{description}</p>
      <p className="mt-auto text-[11px] text-slate-500">
        当前为信息架构占位区域，后续可接入真实后端数据与图表组件。
      </p>
    </section>
  )
}

/**
 * Props for the single vehicle real-time monitor tab.
 */
interface VehicleMonitorProps {
  /** Currently selected vehicle summary. */
  vehicle: VehicleSummary
}

/**
 * Vehicle monitor real-time tab:
 * camera, lane-level map and telemetry / status summary.
 */
const VehicleMonitorRealtimeTab: React.FC<VehicleMonitorProps> = ({ vehicle }) => {
  return (
    <div className="h-full flex flex-col gap-4">
      {/* Upper part: camera + lane map for pure monitoring */}
      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[minmax(0,2.3fr)_minmax(0,1.7fr)] gap-4">
        <CameraPanel />
        <LaneMapPanel />
      </div>

      {/* Lower telemetry cards */}
      <div className="grid grid-cols-1 xl:grid-cols-4 gap-4">
        <TelemetryCard title="车辆动态">
          <ul className="space-y-1 text-xs text-slate-300">
            <li className="flex justify-between">
              <span>车速</span>
              <span className="font-semibold">
                {vehicle.speedKmh.toFixed(1)} km/h
              </span>
            </li>
            <li className="flex justify-between">
              <span>方向盘转角</span>
              <span>-2.3°</span>
            </li>
            <li className="flex justify-between">
              <span>纵向加速度</span>
              <span>0.12 m/s²</span>
            </li>
            <li className="flex justify-between">
              <span>横向加速度</span>
              <span>-0.08 m/s²</span>
            </li>
          </ul>
        </TelemetryCard>
        <TelemetryCard title="定位信息">
          <ul className="space-y-1 text-xs text-slate-300">
            <li className="flex justify-between">
              <span>定位状态</span>
              <span className="text-emerald-400">融合定位 · 正常</span>
            </li>
            <li className="flex justify-between">
              <span>GNSS</span>
              <span className="text-emerald-400">FIX</span>
            </li>
            <li className="flex justify-between">
              <span>车道偏移</span>
              <span>+0.18 m</span>
            </li>
            <li className="flex justify-between">
              <span>航向角误差</span>
              <span>0.6°</span>
            </li>
          </ul>
        </TelemetryCard>
        <TelemetryCard title="感知与规划">
          <ul className="space-y-1 text-xs text-slate-300">
            <li className="flex justify-between">
              <span>感知目标数</span>
              <span>14</span>
            </li>
            <li className="flex justify-between">
              <span>车道线检测</span>
              <span className="text-emerald-400">正常</span>
            </li>
            <li className="flex justify-between">
              <span>可通行区域</span>
              <span className="text-emerald-400">正常</span>
            </li>
            <li className="flex justify-between">
              <span>规划状态</span>
              <span className="text-emerald-400">正常</span>
            </li>
          </ul>
        </TelemetryCard>
        <TelemetryCard title="计算与通信">
          <ul className="space-y-1 text-xs text-slate-300">
            <li className="flex justify-between">
              <span>GPU 利用率</span>
              <span>42%</span>
            </li>
            <li className="flex justify-between">
              <span>CPU 利用率</span>
              <span>38%</span>
            </li>
            <li className="flex justify-between">
              <span>推理时延</span>
              <span>68 ms</span>
            </li>
            <li className="flex justify-between">
              <span>网络延迟</span>
              <span>12 ms</span>
            </li>
          </ul>
        </TelemetryCard>
      </div>
    </div>
  )
}

/**
 * Props for the dedicated remote driving page.
 */
interface RemoteDriveProps {
  /** Currently selected vehicle used for HUD data and labels. */
  vehicle: VehicleSummary
  /** Callback to return to fleet overview. */
  onBackToFleet: () => void
}

/**
 * Full-screen remote driving page focused on camera feed and controls.
 * Uses the RemoteDrivingCanvas for a racing-game-like cockpit experience.
 */
const RemoteDrive: React.FC<RemoteDriveProps> = ({ vehicle, onBackToFleet }) => {
  const [isFullscreen, setIsFullscreen] = useState(false)

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Breadcrumb + compact vehicle info for quick context */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-3 text-sm">
          <button
            type="button"
            onClick={onBackToFleet}
            className="px-2 py-1 rounded-lg bg-slate-900 border border-slate-800 text-xs text-slate-300 hover:border-slate-700"
          >
            车队总览
          </button>
        </div>
        <div className="flex items-center gap-3 text-xs text-slate-400">
          <div className="flex items-center gap-1">
            <Gauge className="w-3 h-3" />
            <span>车速</span>
            <span className="text-slate-100 font-semibold">
              {vehicle.speedKmh} km/h
            </span>
          </div>
          <div className="flex items-center gap-1">
            <Zap className="w-3 h-3 text-emerald-400" />
            <span>模式 · 远程驾驶</span>
          </div>
          <button
            type="button"
            onClick={() => setIsFullscreen(true)}
            className="px-2 py-1 rounded-md border border-slate-700 bg-slate-900 text-[11px] text-slate-200 hover:border-sky-500"
          >
            全屏视图
          </button>
        </div>
      </div>

      {/* Remote driving workspace: large canvas + right-side control & status */}
      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[minmax(0,2.5fr)_minmax(0,1.5fr)] gap-4">
        <RemoteDrivingCanvas vehicle={vehicle} />

        <section className="flex flex-col gap-3">
          <RemoteControlPanel />

          <section className="bg-slate-900/70 border border-slate-800 rounded-xl p-3 text-xs text-slate-300">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-medium text-slate-200">车辆状态（示例）</span>
              <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                链路正常
              </span>
            </div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              <div className="flex items-center justify-between">
                <span className="text-slate-400">当前车辆</span>
                <span className="text-slate-100 font-semibold">{vehicle.id}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">自动驾驶</span>
                <span className="text-emerald-400">开启</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">电量</span>
                <span className="text-sky-200">68%</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">网络</span>
                <span className="text-slate-100">5G · 延迟 12 ms</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">定位</span>
                <span className="text-emerald-400">RTK FIX</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-slate-400">最后更新</span>
                <span className="text-slate-200">{vehicle.lastUpdate}</span>
              </div>
            </div>
          </section>
        </section>
      </div>

      {isFullscreen && (
        <div className="fixed inset-0 z-50 bg-slate-950">
          <div className="absolute top-3 right-4 z-50 flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIsFullscreen(false)}
              className="px-3 py-1.5 rounded-lg bg-slate-900/90 border border-slate-700 text-xs text-slate-100 hover:border-sky-500"
            >
              退出全屏
            </button>
          </div>
          <div className="h-full w-full p-3">
            <RemoteDrivingCanvas vehicle={vehicle} />
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * Camera panel showing the main front-view camera.
 * Image is a static placeholder that can later be replaced by a live video feed.
 */
const CameraPanel: React.FC = () => {
  return (
    <section className="bg-slate-900/70 border border-slate-800 rounded-xl p-3 flex flex-col min-h-[260px]">
      <div className="flex items-center justify-between mb-2 text-xs text-slate-300">
        <div className="flex items-center gap-2">
          <span className="font-medium">主视角 · 前视摄像头</span>
          <span className="px-1.5 py-0.5 rounded-full bg-red-900/40 text-red-300 border border-red-700/60">
            录像中
          </span>
          <span className="px-1.5 py-0.5 rounded-full bg-slate-800 text-slate-200 border border-slate-700">
            LIVE
          </span>
        </div>
        <div className="flex items-center gap-3">
          <span>1080P</span>
          <span>32 km/h</span>
        </div>
      </div>
      <div className="relative w-full pb-[56.25%] rounded-lg overflow-hidden bg-slate-950">
        <img
          src="https://pub-cdn.sider.ai/u/U06XHJ80209/web-coder/6add4e269654c16911758e99/resource/9fffc6cd-027d-472a-b2f1-f93d7593b500.jpg"
          alt="Front camera view"
          className="absolute inset-0 w-full h-full object-cover"
        />
      </div>
      <div className="mt-2 flex gap-2 text-[11px] text-slate-400">
        <span className="px-2 py-0.5 rounded-full bg-slate-800/80 border border-slate-700">
          目标框
        </span>
        <span className="px-2 py-0.5 rounded-full bg-slate-800/80 border border-slate-700">
          车道线
        </span>
        <span className="px-2 py-0.5 rounded-full bg-slate-800/80 border border-slate-700">
          可通行区域
        </span>
      </div>
    </section>
  )
}

/**
 * Lane-level localization map panel using a placeholder image.
 */
const LaneMapPanel: React.FC = () => {
  return (
    <section className="bg-slate-900/70 border border-slate-800 rounded-xl p-3 flex flex-col min-h-[260px]">
      <div className="flex items-center justify-between mb-2 text-xs text-slate-300">
        <span className="font-medium">车道级定位</span>
        <span className="text-[11px] text-emerald-400">定位置信度 98.7%</span>
      </div>
      <div className="relative w-full pb-[56.25%] rounded-lg overflow-hidden bg-slate-950">
        <img
          src="https://pub-cdn.sider.ai/u/U06XHJ80209/web-coder/6add4e269654c16911758e99/resource/d080c452-756a-43e8-b34a-17d0d1559e33.jpg"
          alt="Lane-level localization"
          className="absolute inset-0 w-full h-full object-cover"
        />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-slate-300">
        <div className="flex items-center gap-1">
          <div className="w-3 h-1 rounded-full bg-sky-400" />
          <span>当前车道</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-1 rounded-full bg-emerald-400" />
          <span>规划轨迹</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-1 rounded-full bg-amber-400" />
          <span>相邻车道</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-1 rounded-full bg-red-400" />
          <span>周边车辆</span>
        </div>
      </div>
    </section>
  )
}

/**
 * Remote control panel for teleoperation commands.
 * This implementation only provides UI; it does not send real commands yet.
 */
const RemoteControlPanel: React.FC = () => {
  return (
    <section className="bg-slate-900/70 border border-slate-800 rounded-xl p-3 flex flex-col min-h-[260px]">
      <div className="flex items-center justify-between mb-2 text-xs text-slate-300">
        <span className="font-medium">远程控制</span>
        <span className="text-[11px] text-slate-500">演示 UI · 未连接真实车辆</span>
      </div>
      <div className="mb-2 flex gap-2">
        <button className="flex-1 px-2 py-1 rounded-md text-xs bg-slate-800 text-slate-100 border border-sky-600">
          手动控制
        </button>
        <button className="flex-1 px-2 py-1 rounded-md text-xs bg-slate-900 text-slate-300 border border-slate-700">
          任务控制
        </button>
      </div>
      <div className="flex-1 flex flex-col gap-3">
        {/* Directional pad */}
        <div className="flex justify-center">
          <div className="w-32 h-32 rounded-full bg-slate-950 border border-slate-700 flex items-center justify-center relative">
            <button className="absolute top-1/6 -translate-y-1/2 px-2 py-1 rounded-md bg-slate-800 border border-slate-700 text-[11px]">
              前进
            </button>
            <button className="absolute bottom-1/6 translate-y-1/2 px-2 py-1 rounded-md bg-slate-800 border border-slate-700 text-[11px]">
              后退
            </button>
            <button className="absolute left-1/6 -translate-x-1/2 px-2 py-1 rounded-md bg-slate-800 border border-slate-700 text-[11px]">
              左转
            </button>
            <button className="absolute right-1/6 translate-x-1/2 px-2 py-1 rounded-md bg-slate-800 border border-slate-700 text-[11px]">
              右转
            </button>
            <div className="w-10 h-10 rounded-full bg-sky-600 flex items-center justify-center shadow-lg shadow-sky-700/50">
              <Car className="w-4 h-4 text-slate-950" />
            </div>
          </div>
        </div>
        {/* Speed control */}
        <div className="space-y-2">
          <div className="flex items-center justify-between text-xs text-slate-300">
            <span>当前设定速度</span>
            <span className="text-base font-semibold">32 km/h</span>
          </div>
          <div className="flex gap-2">
            {[10, 20, 30, 50].map((v) => (
              <button
                key={v}
                className={`flex-1 py-1 rounded-md border text-xs ${
                  v === 30
                    ? 'bg-sky-600 text-slate-950 border-sky-500'
                    : 'bg-slate-900 text-slate-200 border-slate-700 hover:border-slate-500'
                }`}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        {/* Emergency stop */}
        <button className="mt-1 w-full py-2 rounded-lg bg-red-600 text-slate-50 text-xs font-semibold border border-red-400 hover:bg-red-500">
          紧急停车
        </button>
      </div>
    </section>
  )
}

/**
 * Props for the main remote driving canvas area.
 */
interface RemoteDrivingCanvasProps {
  /** Vehicle providing dynamic values such as speed. */
  vehicle: VehicleSummary
}

/**
 * Main remote driving interface: large camera view with overlay controls and a mini map.
 * Designed similar to a racing cockpit so the operator focuses on video and control.
 * This is a pure UI demo and does not send real control commands yet.
 */
const RemoteDrivingCanvas: React.FC<RemoteDrivingCanvasProps> = ({ vehicle }) => {
  return (
    <section className="h-full bg-slate-900/70 border border-slate-800 rounded-xl p-3 flex flex-col">
      <div className="mb-2 flex items-center justify-between text-xs text-slate-300">
        <div className="flex items-center gap-2">
          <span className="font-medium">远程驾驶视角 · 前视摄像头</span>
          <span className="px-1.5 py-0.5 rounded-full bg-red-900/40 text-red-300 border border-red-700/60">
            录像中
          </span>
          <span className="px-1.5 py-0.5 rounded-full bg-slate-800 text-slate-200 border border-slate-700">
            LIVE
          </span>
        </div>
        <div className="flex items-center gap-3 text-[11px]">
          <span className="text-slate-400">操作模式：远程驾驶</span>
          <span className="text-slate-500">
            键盘：W / A / S / D 或 ↑ ← ↓ →（演示）
          </span>
        </div>
      </div>

      <div className="relative flex-1 rounded-lg overflow-hidden bg-slate-950">
        {/* 主相机画面 */}
        <img
          src="https://pub-cdn.sider.ai/u/U06XHJ80209/web-coder/6add4e269654c16911758e99/resource/9fffc6cd-027d-472a-b2f1-f93d7593b500.jpg"
          alt="Remote driving front camera"
          className="absolute inset-0 h-full w-full object-cover"
        />

        {/* 顶部/底部渐变，增强 HUD 可读性 */}
        <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-slate-950/80 via-slate-950/40 to-transparent" />
        <div className="pointer-events-none absolute inset-x-0 bottom-0 h-28 bg-gradient-to-t from-slate-950/95 via-slate-950/60 to-transparent" />

        {/* 右上角车道级小地图 */}
        <div className="absolute right-3 top-3 w-40 sm:w-48 md:w-60 rounded-lg border border-slate-700 bg-slate-950/90 shadow-lg shadow-slate-900/80 overflow-hidden">
          <div className="flex items-center justify-between px-2 py-1.5 text-[10px] text-slate-300 bg-slate-900/90 border-b border-slate-800">
            <span className="flex items-center gap-1">
              <Map className="h-3 w-3" />
              <span>车道级小地图</span>
            </span>
            <span className="text-emerald-400">置信度 98.7%</span>
          </div>
          <div className="relative w-full pb-[56.25%] bg-slate-950">
            <img
              src="https://pub-cdn.sider.ai/u/U06XHJ80209/web-coder/6add4e269654c16911758e99/resource/d080c452-756a-43e8-b34a-17d0d1559e33.jpg"
              alt="Lane-level mini map view"
              className="absolute inset-0 h-full w-full object-cover"
            />
          </div>
        </div>

        {/* 左上角仪表盘：速度 / 档位 / 链路状态 */}
        <div className="absolute left-4 top-4 flex flex-col gap-2 text-xs text-slate-100">
          <div className="px-3 py-2 rounded-xl bg-slate-950/80 border border-slate-700/80 shadow-lg shadow-slate-950/70 flex items-center gap-4">
            <div>
              <div className="text-[10px] text-slate-400 uppercase tracking-wide">
                SPEED
              </div>
              <div className="text-2xl font-semibold leading-none tracking-tight">
                {vehicle.speedKmh.toFixed(0)}
              </div>
              <div className="text-[11px] text-slate-400">km/h</div>
            </div>
            <div className="h-10 w-px bg-slate-700/80" />
            <div className="flex flex-col gap-1">
              <div className="text-[10px] text-slate-400 uppercase tracking-wide">
                GEAR
              </div>
              <div className="text-sm font-semibold text-emerald-300">D</div>
              <div className="inline-flex items-center gap-1 rounded-full bg-emerald-950/70 px-1.5 py-0.5 border border-emerald-700/80">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-[9px] text-emerald-200">链路正常</span>
              </div>
            </div>
          </div>
        </div>

        {/* 底部中间：方向 + 油门 / 制动控制区域 */}
        <div className="absolute inset-x-4 bottom-4 flex justify-center">
          <div className="w-full max-w-xl flex flex-col gap-3">
            <div className="flex justify-center">
              <div className="w-32 h-32 rounded-full bg-slate-950/90 border border-slate-700 flex items-center justify-center relative backdrop-blur-sm">
                <button
                  type="button"
                  className="absolute left-1/2 top-2 -translate-x-1/2 px-3 py-1 rounded-md bg-slate-800/90 border border-slate-600 text-[11px] text-slate-100 hover:border-sky-500"
                >
                  前进
                </button>
                <button
                  type="button"
                  className="absolute left-1/2 bottom-2 -translate-x-1/2 px-3 py-1 rounded-md bg-slate-800/90 border border-slate-600 text-[11px] text-slate-100 hover:border-sky-500"
                >
                  制动
                </button>
                <button
                  type="button"
                  className="absolute left-2 top-1/2 -translate-y-1/2 px-3 py-1 rounded-md bg-slate-800/90 border border-slate-600 text-[11px] text-slate-100 hover:border-sky-500"
                >
                  左转
                </button>
                <button
                  type="button"
                  className="absolute right-2 top-1/2 -translate-y-1/2 px-3 py-1 rounded-md bg-slate-800/90 border border-slate-600 text-[11px] text-slate-100 hover:border-sky-500"
                >
                  右转
                </button>
                <div className="w-10 h-10 rounded-full bg-sky-600 flex items-center justify-center shadow-lg shadow-sky-700/50">
                  <Car className="h-4 w-4 text-slate-950" />
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between text-[11px]">
              <span className="text-slate-400">
                提示：方向键 / W A S D 控制方向与油门（当前为演示 UI，不下发真实指令）
              </span>
              <button
                type="button"
                className="px-3 py-1.5 rounded-lg bg-red-600 text-slate-50 text-xs font-semibold border border-red-400 hover:bg-red-500"
              >
                紧急停车
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  )
}

/**
 * Generic small telemetry card used in the lower information grid.
 */
const TelemetryCard: React.FC<{ title: string; children: React.ReactNode }> = ({
  title,
  children,
}) => {
  return (
    <section className="bg-slate-900/70 border border-slate-800 rounded-xl p-3 flex flex-col gap-2">
      <div className="text-xs font-medium text-slate-200">{title}</div>
      <div>{children}</div>
    </section>
  )
}

/**
 * Alert center component showing incidents and handling reports.
 */
const AlertCenter: React.FC = () => {
  const [severityFilter, setSeverityFilter] = useState<'all' | AlertSeverity>('all')
  const [statusFilter, setStatusFilter] = useState<'all' | AlertStatus>('all')
  const [selectedId, setSelectedId] = useState<string>('AL-20261023-001')

  const alerts: AlertRecord[] = [
    {
      id: 'AL-20261023-001',
      time: '2026-10-23 08:20:17',
      vehicleId: 'AV-019',
      title: '前方车辆距离过近，触发自动减速',
      severity: 'warning',
      status: 'closed',
      location: '测试园区 · 南二路交叉口',
      description:
        '车辆在南二路交叉口跟随前车行驶时，前车突然减速，系统检测到安全距离小于阈值，触发纵向紧急减速策略。',
      impact: '车速从 28 km/h 降至 12 km/h，未发生碰撞，乘坐舒适性轻微受影响。',
      cause:
        '前方车辆突发减速，结合路口信号切换，系统保守策略生效，属于正常防御性驾驶行为。',
      resolution:
        '自动减速完成后，系统重新评估前车轨迹与距离，在安全范围内恢复巡航速度。',
      followUp:
        '建议在类似交叉口场景中优化加减速平顺性；本次事件用于训练数据采集与策略调优。',
    },
    {
      id: 'AL-20261023-002',
      time: '2026-10-23 08:08:45',
      vehicleId: 'AV-012',
      title: '临时障碍物占道，自动变道绕行',
      severity: 'info',
      status: 'closed',
      location: '测试园区 · 东侧路',
      description:
        '感知到前方施工路障占据当前车道，规划模块生成安全变道轨迹，并完成自动绕行。',
      impact: '车辆短时降速至 20 km/h，绕行距离约 60 m，整体运行正常。',
      cause: '园区道路临时施工，障碍未提前录入高精地图，通过在线感知自动识别处理。',
      resolution:
        '系统按规则完成变道与回到目标车道，全流程无人工干预，事件自动归档。',
      followUp: '建议同步施工计划至运营平台，提前在任务规划时规避相关路段。',
    },
    {
      id: 'AL-20261022-003',
      time: '2026-10-22 19:03:12',
      vehicleId: 'AV-021',
      title: 'GNSS 信号短暂丢失，切换至融合定位',
      severity: 'info',
      status: 'closed',
      location: '测试园区 · 生产车间附近',
      description:
        '车辆经过生产车间高楼密集区域，GNSS 卫星可见数下降，定位模块自动提升 IMU + 轮速融合权重。',
      impact: '定位精度在 3 秒内略有波动，车辆速度与轨迹保持稳定，无安全风险。',
      cause: '环境遮挡导致 GNSS 信号质量下降，为预期场景。',
      resolution: 'GNSS 恢复后自动切回正常权重配置，整段行驶无异常。',
      followUp: '持续监控此区域定位质量，结合历史数据评估是否需要加装地基站。',
    },
    {
      id: 'AL-20261021-004',
      time: '2026-10-21 10:42:09',
      vehicleId: 'AV-006',
      title: '行人突然横穿，执行紧急制动',
      severity: 'critical',
      status: 'in-progress',
      location: '测试园区 · 物流中心北门',
      description:
        '一名行人在未设人行横道位置快速横穿道路，感知系统检测到高风险运动轨迹，规划立即生成紧急制动轨迹。',
      impact:
        '车辆从 26 km/h 紧急制动至 0 km/h，制动距离约 8.4 m，未发生接触，乘客主观感受制动明显。',
      cause:
        '行人违规横穿，属于外部突发事件。系统响应符合安全设计要求，仍需进一步复盘制动舒适性。',
      resolution:
        '事件日志与传感器数据已上传至云端，正在进行多部门联合复盘，临时提高该路段速度上限控制。',
      followUp:
        '建议在物流中心北门增设减速带与醒目警示标识，评估是否增加 V2X 行人提醒设备。',
    },
  ]

  const filteredAlerts = alerts.filter((a) => {
    if (severityFilter !== 'all' && a.severity !== severityFilter) return false
    if (statusFilter !== 'all' && a.status !== statusFilter) return false
    return true
  })

  const selected =
    filteredAlerts.find((a) => a.id === selectedId) ??
    filteredAlerts[0] ??
    alerts[0]

  /**
   * Returns CSS classes for severity pill.
   */
  const severityClass = (severity: AlertSeverity) => {
    if (severity === 'critical') {
      return 'bg-red-900/50 text-red-200 border-red-500/70'
    }
    if (severity === 'warning') {
      return 'bg-amber-900/40 text-amber-200 border-amber-500/70'
    }
    return 'bg-sky-900/40 text-sky-200 border-sky-500/70'
  }

  /**
   * Returns human readable severity label.
   */
  const severityLabel = (severity: AlertSeverity) => {
    if (severity === 'critical') return '严重'
    if (severity === 'warning') return '警告'
    return '信息'
  }

  /**
   * Returns human readable status label.
   */
  const statusLabel = (status: AlertStatus) => {
    if (status === 'open') return '未处理'
    if (status === 'in-progress') return '处理中'
    return '已关闭'
  }

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Header + summary */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold text-slate-100">告警事件中心</h1>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-900 border border-slate-700 text-[11px] text-slate-300">
              <FileText className="w-3 h-3" />
              自动驾驶事故记录与处置
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            聚合自动驾驶运行过程中的风险事件，支持按严重程度与处理进度进行筛选和审计。
          </p>
        </div>
        <div className="flex gap-3 text-xs">
          <div className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 flex items-center gap-2">
            <AlertTriangle className="w-3 h-3 text-amber-300" />
            <span>近 24 小时事件</span>
            <span className="font-semibold">{alerts.length}</span>
          </div>
          <div className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 flex items-center gap-2">
            <Clock className="w-3 h-3 text-sky-300" />
            <span>平均关闭时长</span>
            <span className="font-semibold">18 min</span>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center justify-between gap-3 text-xs">
        <div className="flex items-center gap-2">
          <span className="text-slate-400">严重程度</span>
          <div className="inline-flex rounded-full bg-slate-900 border border-slate-800 p-0.5">
            {[
              { key: 'all' as const, label: '全部' },
              { key: 'critical' as const, label: '严重' },
              { key: 'warning' as const, label: '警告' },
              { key: 'info' as const, label: '信息' },
            ].map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setSeverityFilter(item.key)}
                className={[
                  'px-2.5 py-0.5 rounded-full',
                  severityFilter === item.key
                    ? 'bg-sky-600 text-slate-950'
                    : 'text-slate-300',
                ].join(' ')}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-slate-400">处理状态</span>
          <div className="inline-flex rounded-full bg-slate-900 border border-slate-800 p-0.5">
            {[
              { key: 'all' as const, label: '全部' },
              { key: 'open' as const, label: '未处理' },
              { key: 'in-progress' as const, label: '处理中' },
              { key: 'closed' as const, label: '已关闭' },
            ].map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setStatusFilter(item.key)}
                className={[
                  'px-2.5 py-0.5 rounded-full',
                  statusFilter === item.key
                    ? 'bg-emerald-600 text-slate-950'
                    : 'text-slate-300',
                ].join(' ')}
              >
                {item.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* List + detail */}
      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,2.3fr)] gap-4">
        {/* Left: alert list */}
        <section className="bg-slate-900/70 border border-slate-800 rounded-xl flex flex-col">
          <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between text-xs text-slate-300">
            <span className="font-medium">告警列表</span>
            <span className="text-slate-500">
              共 {filteredAlerts.length} 条 · 点击查看详情与处置报告
            </span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto">
            {filteredAlerts.map((alert) => (
              <button
                key={alert.id}
                type="button"
                onClick={() => setSelectedId(alert.id)}
                className={[
                  'w-full text-left px-3 py-2 border-b border-slate-800/80 flex flex-col gap-1 hover:bg-slate-900',
                  alert.id === selectedId ? 'bg-slate-900/80' : '',
                ].join(' ')}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className="text-[11px] text-slate-500">{alert.id}</span>
                    <span
                      className={[
                        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px]',
                        severityClass(alert.severity),
                      ].join(' ')}
                    >
                      <AlertTriangle className="w-3 h-3" />
                      {severityLabel(alert.severity)}
                    </span>
                    <span className="text-xs font-medium text-slate-100 truncate">
                      {alert.title}
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-500 whitespace-nowrap">
                    {alert.time}
                  </span>
                </div>
                <div className="flex items-center justify-between text-[11px] text-slate-500">
                  <span className="truncate">
                    车辆 {alert.vehicleId} · {alert.location}
                  </span>
                  <span>
                    状态：
                    <span
                      className={
                        alert.status === 'closed'
                          ? 'text-emerald-400'
                          : alert.status === 'in-progress'
                          ? 'text-amber-300'
                          : 'text-red-300'
                      }
                    >
                      {statusLabel(alert.status)}
                    </span>
                  </span>
                </div>
              </button>
            ))}
            {filteredAlerts.length === 0 && (
              <div className="px-3 py-6 text-center text-xs text-slate-500">
                当前筛选条件下暂无告警事件。
              </div>
            )}
          </div>
        </section>

        {/* Right: alert detail / report */}
        <section className="bg-slate-900/70 border border-slate-800 rounded-xl flex flex-col">
          <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between text-xs text-slate-300">
            <div className="flex items-center gap-2">
              <span className="font-medium">事件详情与处置报告</span>
              <span className="text-slate-500">{selected.time}</span>
            </div>
            <div className="flex items-center gap-2">
              <span
                className={[
                  'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px]',
                  severityClass(selected.severity),
                ].join(' ')}
              >
                <AlertTriangle className="w-3 h-3" />
                {severityLabel(selected.severity)}
              </span>
              <span className="text-[11px] text-slate-400">
                状态：{statusLabel(selected.status)}
              </span>
            </div>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-3 text-xs text-slate-300">
            <div>
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-slate-100">
                  {selected.title}
                </h2>
                <span className="text-[11px] text-slate-400">
                  车辆 {selected.vehicleId} · {selected.location}
                </span>
              </div>
              <p className="mt-1 text-slate-300 leading-relaxed">
                {selected.description}
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
                <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mb-1">
                  <Activity className="w-3 h-3" />
                  <span>影响范围</span>
                </div>
                <p className="text-[11px] text-slate-200 leading-relaxed">
                  {selected.impact}
                </p>
              </div>
              <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
                <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mb-1">
                  <FileText className="w-3 h-3" />
                  <span>根因分析</span>
                </div>
                <p className="text-[11px] text-slate-200 leading-relaxed">
                  {selected.cause}
                </p>
              </div>
              <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
                <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mb-1">
                  <ClipboardList className="w-3 h-3" />
                  <span>处置结果</span>
                </div>
                <p className="text-[11px] text-slate-200 leading-relaxed">
                  {selected.resolution}
                </p>
              </div>
            </div>

            <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5 text-[11px] text-slate-400">
                  <Clock className="w-3 h-3" />
                  <span>后续跟进与改进建议</span>
                </div>
              </div>
              <p className="text-[11px] text-slate-200 leading-relaxed">
                {selected.followUp}
              </p>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

/**
 * Task management center for creating and dispatching missions.
 */
interface TaskCenterProps {
  /** All vehicles available for task dispatch. */
  vehicles: VehicleSummary[]
}

/**
 * Task management UI with list and creation form.
 */
const TaskCenter: React.FC<TaskCenterProps> = ({ vehicles }) => {
  const [selectedTaskId, setSelectedTaskId] = useState<string>('TK-20261023-001')

  const tasks: TaskRecord[] = [
    {
      id: 'TK-20261023-001',
      name: '园区东侧路巡逻',
      vehicleId: 'AV-012',
      type: '巡逻任务',
      priority: '中',
      status: 'running',
      plannedStart: '2026-10-23 08:00',
      createdBy: 'dispatcher',
      createdAt: '2026-10-23 07:45',
      from: '测试园区 · 北门',
      to: '测试园区 · 东侧路全段',
    },
    {
      id: 'TK-20261023-002',
      name: '生产车间物料配送',
      vehicleId: 'AV-021',
      type: '物料运输',
      priority: '高',
      status: 'scheduled',
      plannedStart: '2026-10-23 09:30',
      createdBy: 'scheduler',
      createdAt: '2026-10-23 08:50',
      from: '物流中心 · 北仓',
      to: '生产车间 · 装载区',
    },
    {
      id: 'TK-20261023-003',
      name: '西侧路高峰拥堵巡检',
      vehicleId: 'AV-008',
      type: '巡逻任务',
      priority: '中',
      status: 'draft',
      plannedStart: '2026-10-23 17:00',
      createdBy: 'planner',
      createdAt: '2026-10-23 08:10',
      from: '测试园区 · 中央停车区',
      to: '测试园区 · 西侧路',
    },
    {
      id: 'TK-20261022-004',
      name: '夜间园区安全巡逻',
      vehicleId: 'AV-006',
      type: '巡逻任务',
      priority: '低',
      status: 'completed',
      plannedStart: '2026-10-22 21:00',
      createdBy: 'dispatcher',
      createdAt: '2026-10-22 19:30',
      from: '测试园区 · 南门',
      to: '测试园区 · 全园区',
    },
  ]

  const selected = tasks.find((t) => t.id === selectedTaskId) ?? tasks[0]

  /**
   * Returns human readable task status label.
   */
  const taskStatusLabel = (status: TaskStatus) => {
    if (status === 'draft') return '草稿'
    if (status === 'scheduled') return '已排程'
    if (status === 'running') return '执行中'
    if (status === 'completed') return '已完成'
    return '已取消'
  }

  /**
   * Returns style classes for task status badge.
   */
  const taskStatusClass = (status: TaskStatus) => {
    if (status === 'running') {
      return 'bg-emerald-900/40 text-emerald-200 border-emerald-500/70'
    }
    if (status === 'scheduled') {
      return 'bg-sky-900/40 text-sky-200 border-sky-500/70'
    }
    if (status === 'draft') {
      return 'bg-slate-900 text-slate-300 border-slate-600/70'
    }
    if (status === 'completed') {
      return 'bg-slate-900 text-emerald-200 border-emerald-500/60'
    }
    return 'bg-slate-900 text-slate-400 border-slate-600/70'
  }

  /**
   * Returns style classes for task priority.
   */
  const priorityClass = (priority: TaskRecord['priority']) => {
    if (priority === '高') {
      return 'text-red-300'
    }
    if (priority === '中') {
      return 'text-amber-300'
    }
    return 'text-slate-300'
  }

  const runningCount = tasks.filter((t) => t.status === 'running').length
  const scheduledCount = tasks.filter((t) => t.status === 'scheduled').length
  const completedToday = tasks.filter((t) => t.status === 'completed').length

  return (
    <div className="h-full flex flex-col gap-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex flex-col">
          <div className="flex items-center gap-2">
            <h1 className="text-sm font-semibold text-slate-100">任务管理中心</h1>
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-900 border border-slate-700 text-[11px] text-slate-300">
              <ClipboardList className="w-3 h-3" />
              下发与编排自动驾驶任务
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            支持配置巡逻、物料运输等任务，统一管理任务生命周期，提升运营效率。
          </p>
        </div>
        <div className="flex gap-3 text-xs">
          <div className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 flex items-center gap-2">
            <Activity className="w-3 h-3 text-emerald-300" />
            <span>执行中</span>
            <span className="font-semibold">{runningCount}</span>
          </div>
          <div className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 flex items-center gap-2">
            <Clock className="w-3 h-3 text-sky-300" />
            <span>已排程</span>
            <span className="font-semibold">{scheduledCount}</span>
          </div>
          <div className="px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 text-slate-200 flex items-center gap-2">
            <Gauge className="w-3 h-3 text-amber-300" />
            <span>今日完成</span>
            <span className="font-semibold">{completedToday}</span>
          </div>
        </div>
      </div>

      {/* Main layout: task list + creation form */}
      <div className="flex-1 min-h-0 grid grid-cols-1 xl:grid-cols-[minmax(0,2.1fr)_minmax(0,1.6fr)] gap-4">
        {/* Task list and detail */}
        <section className="bg-slate-900/70 border border-slate-800 rounded-xl flex flex-col">
          <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between text-xs text-slate-300">
            <span className="font-medium">任务列表</span>
            <span className="text-slate-500">
              共 {tasks.length} 条 · 选择任务查看详情
            </span>
          </div>
          <div className="flex-1 min-h-0 grid grid-rows-[minmax(0,1.4fr)_minmax(0,1.2fr)]">
            {/* Upper: list */}
            <div className="overflow-y-auto border-b border-slate-800/80">
              {tasks.map((task) => (
                <button
                  key={task.id}
                  type="button"
                  onClick={() => setSelectedTaskId(task.id)}
                  className={[
                    'w-full text-left px-3 py-2 flex flex-col gap-1 border-b border-slate-800/70 hover:bg-slate-900',
                    task.id === selectedTaskId ? 'bg-slate-900/80' : '',
                  ].join(' ')}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="text-[11px] text-slate-500">{task.id}</span>
                      <span
                        className={[
                          'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px]',
                          taskStatusClass(task.status),
                        ].join(' ')}
                      >
                        {task.status === 'completed' ? (
                          <svg
                            className="w-3 h-3 text-emerald-300"
                            viewBox="0 0 16 16"
                            aria-hidden="true"
                          >
                            <path
                              d="M6.5 10.5L3.5 7.5L2.5 8.5L6.5 12.5L13.5 5.5L12.5 4.5L6.5 10.5Z"
                              fill="currentColor"
                            />
                          </svg>
                        ) : (
                          <svg
                            className="w-3 h-3 text-sky-300"
                            viewBox="0 0 16 16"
                            aria-hidden="true"
                          >
                            <circle cx="8" cy="8" r="6" stroke="currentColor" />
                          </svg>
                        )}
                        {taskStatusLabel(task.status)}
                      </span>
                      <span className="text-xs font-medium text-slate-100 truncate">
                        {task.name}
                      </span>
                    </div>
                    <span className={`text-[11px] ${priorityClass(task.priority)}`}>
                      优先级：{task.priority}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] text-slate-500">
                    <span className="truncate">
                      车辆 {task.vehicleId} · {task.type}
                    </span>
                    <span className="whitespace-nowrap">
                      计划开始 {task.plannedStart}
                    </span>
                  </div>
                </button>
              ))}
            </div>

            {/* Lower: selected task detail */}
            <div className="p-3 text-xs text-slate-300 overflow-y-auto">
              <div className="flex items-center justify-between gap-2 mb-1.5">
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <h2 className="text-sm font-semibold text-slate-100">
                      {selected.name}
                    </h2>
                    <span
                      className={[
                        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-[10px]',
                        taskStatusClass(selected.status),
                      ].join(' ')}
                    >
                      {taskStatusLabel(selected.status)}
                    </span>
                  </div>
                  <span className="text-[11px] text-slate-500">
                    任务 ID {selected.id} · 车辆 {selected.vehicleId}
                  </span>
                </div>
                <div className="flex flex-col items-end text-[11px] text-slate-500">
                  <span>
                    创建人 {selected.createdBy} · {selected.createdAt}
                  </span>
                  <span>计划开始 {selected.plannedStart}</span>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2">
                <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
                  <div className="text-[11px] text-slate-400 mb-1">任务类型</div>
                  <div className="text-[11px] text-slate-200">{selected.type}</div>
                </div>
                <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
                  <div className="text-[11px] text-slate-400 mb-1">起点</div>
                  <div className="text-[11px] text-slate-200">{selected.from}</div>
                </div>
                <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
                  <div className="text-[11px] text-slate-400 mb-1">终点</div>
                  <div className="text-[11px] text-slate-200">{selected.to}</div>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
                  <div className="text-[11px] text-slate-400 mb-1">调度建议</div>
                  <p className="text-[11px] text-slate-200 leading-relaxed">
                    根据当前车队负载与车辆分布，建议使用
                    {selected.vehicleId} 执行任务，避免跨区域调度带来的空驶成本。
                  </p>
                </div>
                <div className="bg-slate-950/60 border border-slate-800 rounded-lg p-2.5">
                  <div className="text-[11px] text-slate-400 mb-1">约束与注意事项</div>
                  <p className="text-[11px] text-slate-200 leading-relaxed">
                    请确认任务时间不与车辆维护窗口冲突，物料运输任务需预留装卸时间，并关注相关道路的限速与禁行规则。
                  </p>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* Right: new task form */}
        <section className="bg-slate-900/70 border border-slate-800 rounded-xl flex flex-col">
          <div className="px-3 py-2 border-b border-slate-800 flex items-center justify-between text-xs text-slate-300">
            <span className="font-medium">新建任务（演示表单）</span>
            <span className="text-[11px] text-slate-500">
              配置好参数后，可接入后端调度服务完成真实下发
            </span>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto p-3 text-xs text-slate-300 space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block mb-1 text-[11px] text-slate-400">
                  任务名称
                </label>
                <input
                  className="w-full px-2 py-1.5 rounded-md bg-slate-950 border border-slate-800 text-[11px] placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
                  placeholder="例如：东侧路早高峰巡逻"
                />
              </div>
              <div>
                <label className="block mb-1 text-[11px] text-slate-400">
                  任务类型
                </label>
                <select className="w-full px-2 py-1.5 rounded-md bg-slate-950 border border-slate-800 text-[11px] focus:outline-none focus:ring-1 focus:ring-sky-500">
                  <option>巡逻任务</option>
                  <option>物料运输</option>
                  <option>应急支援</option>
                  <option>自定义</option>
                </select>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block mb-1 text-[11px] text-slate-400">
                  指定车辆
                </label>
                <select className="w-full px-2 py-1.5 rounded-md bg-slate-950 border border-slate-800 text-[11px] focus:outline-none focus:ring-1 focus:ring-sky-500">
                  {vehicles.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.id} · {v.locationLabel}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block mb-1 text-[11px] text-slate-400">
                  优先级
                </label>
                <div className="flex gap-1.5">
                  {['高', '中', '低'].map((level) => (
                    <button
                      key={level}
                      type="button"
                      className={[
                        'flex-1 px-2 py-1 rounded-md border text-[11px]',
                        level === '中'
                          ? 'bg-sky-600 text-slate-950 border-sky-500'
                          : 'bg-slate-950 text-slate-300 border-slate-700 hover:border-slate-500',
                      ].join(' ')}
                    >
                      {level}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block mb-1 text-[11px] text-slate-400">
                  起点位置
                </label>
                <input
                  className="w-full px-2 py-1.5 rounded-md bg-slate-950 border border-slate-800 text-[11px] placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
                  placeholder="例如：物流中心 · 北仓"
                />
              </div>
              <div>
                <label className="block mb-1 text-[11px] text-slate-400">
                  终点位置
                </label>
                <input
                  className="w-full px-2 py-1.5 rounded-md bg-slate-950 border border-slate-800 text-[11px] placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
                  placeholder="例如：生产车间 · 装载区"
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block mb-1 text-[11px] text-slate-400">
                  计划开始时间
                </label>
                <input
                  className="w-full px-2 py-1.5 rounded-md bg-slate-950 border border-slate-800 text-[11px] placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
                  placeholder="2026-10-23 09:30"
                />
              </div>
              <div>
                <label className="block mb-1 text-[11px] text-slate-400">
                  其他约束（选填）
                </label>
                <input
                  className="w-full px-2 py-1.5 rounded-md bg-slate-950 border border-slate-800 text-[11px] placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500"
                  placeholder="最大速度 / 路线偏好 / 载重等"
                />
              </div>
            </div>

            <div>
              <label className="block mb-1 text-[11px] text-slate-400">
                任务说明（可见给远程驾驶员和运维人员）
              </label>
              <textarea
                className="w-full h-20 px-2 py-1.5 rounded-md bg-slate-950 border border-slate-800 text-[11px] placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-sky-500 resize-none"
                placeholder="补充任务背景、特殊安全要求和现场联系人信息等。"
              />
            </div>

            <div className="flex items-center justify-between mt-1 pt-2 border-t border-slate-800">
              <span className="text-[11px] text-slate-500">
                当前为前端演示表单，提交后可对接调度后端，实现真实任务下发。
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="px-3 py-1.5 rounded-lg border border-slate-700 bg-slate-900 text-[11px] text-slate-200 hover:border-slate-500"
                >
                  保存为草稿
                </button>
                <button
                  type="button"
                  className="px-3 py-1.5 rounded-lg border border-sky-500 bg-sky-600 text-[11px] text-slate-950 font-semibold hover:bg-sky-500"
                >
                  下发任务
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  )
}

export default HomePage
