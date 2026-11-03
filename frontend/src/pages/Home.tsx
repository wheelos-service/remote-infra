import React, { useState } from 'react'
import { useMockFleet } from '../app/MockFleetProvider'
import { initialAlertFilters, type AlertSection, type AlertFilters } from '../lib/vehicle-alerts'
import { useOperationsNavigation } from '../app/useOperationsNavigation'
import type { MonitorListState } from '../lib/vehicle-monitor'
import FleetOverviewPage from './FleetOverview'
import RemoteDriving from './RemoteDriving'
import VehicleAlertCenter from './VehicleAlertCenter'
import VehicleMonitor from './VehicleMonitor'
import { SideNav, TopBar, type MainSection } from '../features/layout/OperationsLayout'
import TaskCenter from '../features/tasks/TaskCenter'

const HomePage: React.FC = () => {
  const { state: route, update, error: navigationError } = useOperationsNavigation()
  const activeSection = route.page
  const setActiveSection = (page: MainSection) => update({ page })
  const selectedVehicleId = route.vehicle
  const setSelectedVehicleId = (vehicle: string) => update({ vehicle })
  const monitorMode = route.view
  const setMonitorMode = (view: 'list' | 'detail') => update({ view })
  const [monitorScroll, setMonitorScroll] = useState(0)
  const monitorList = { query: route.monitorQuery, filter: route.monitorFilter, scrollTop: monitorScroll }
  const setMonitorList = (list: MonitorListState) => {
    setMonitorScroll(list.scrollTop)
    if (list.query !== route.monitorQuery || list.filter !== route.monitorFilter) {
      update({ monitorQuery: list.query, monitorFilter: list.filter }, list.filter === route.monitorFilter)
    }
  }
  const alertFilters: AlertFilters = {
    query: route.query, vehicle: route.alertVehicle, state: route.state, severity: route.severity,
    period: route.period, selectedVehicle: route.selectedVehicle, selectedAlert: route.selectedAlert,
  }
  const setAlertFilters = (value: React.SetStateAction<AlertFilters>) => {
    const filters = typeof value === 'function' ? value(alertFilters) : value
    update({ query: filters.query, alertVehicle: filters.vehicle, state: filters.state,
      severity: filters.severity, period: filters.period, selectedVehicle: filters.selectedVehicle,
      selectedAlert: filters.selectedAlert }, filters.query !== alertFilters.query)
  }
  const alertSection = route.alertSection
  const setAlertSection = (section: AlertSection) => update({ alertSection: section })
  const returnToAlerts = route.fromAlerts === 'yes'
  const setReturnToAlerts = (value: boolean) => update({ fromAlerts: value ? 'yes' : 'no' })
  const driveVehicleId = route.driveVehicle || null
  const setDriveVehicleId = (id: string | null) => update({ driveVehicle: id ?? '' })
  const [driveScroll, setDriveScroll] = useState(0)
  const driveList = { query: route.driveQuery, filter: route.driveFilter, scrollTop: driveScroll }
  const setDriveList = (list: MonitorListState) => {
    setDriveScroll(list.scrollTop)
    if (list.query !== route.driveQuery || list.filter !== route.driveFilter) {
      update({ driveQuery: list.query, driveFilter: list.filter === 'offline' ? 'offline' : 'all' }, list.filter === route.driveFilter)
    }
  }
  const mock = useMockFleet()
  const selected = selectedVehicleId || mock.vehicles.entries[0]?.vehicle_id || ''
  const openAlerts = (vehicle?: string) => {
    setAlertFilters({ ...initialAlertFilters, state: vehicle ? 'all' : 'pending',
      vehicle: vehicle ?? '', selectedVehicle: vehicle ?? '' })
    setAlertSection('work')
    setReturnToAlerts(false)
    setActiveSection('alerts')
  }

  /**
   * Handles selecting a vehicle from either the map or list.
   * Optionally switches to the monitor detail view.
   */
  const handleSelectVehicle = (id: string, goToMonitor = false) => {
    setSelectedVehicleId(id)
    if (goToMonitor) {
      setReturnToAlerts(false)
      setActiveSection('monitor')
      setMonitorMode('detail')
    }
  }

  /**
   * Handles switching main sections from the side navigation.
   * Resets monitor mode to list when entering vehicle monitoring.
   */
  const handleChangeSection = (section: MainSection) => {
    setActiveSection(section)
    setReturnToAlerts(false)
    if (section === 'drive') setDriveVehicleId(null)
    if (section === 'monitor') {
      setMonitorMode('list')
    }
  }

  let content: React.ReactNode
  if (navigationError) {
    content = <section role="alert" className="space-y-4"><p>{navigationError}</p>
      <a href="#/" className="text-sky-300">返回车队总览</a></section>
  } else if (!mock.map || !mock.vehicles.entries.length) {
    content = <PlaceholderSection title={mock.error ? '数据加载失败' : '正在加载车队数据'}
      description={mock.error ?? '读取本地地图与八车 Mock 数据，不连接真实车辆。'} />
  } else if (activeSection === 'fleet') {
    content = (
      <FleetOverviewPage selected={selected} onSelect={handleSelectVehicle} onAlerts={openAlerts}
        query={route.fleetQuery} filter={route.fleetFilter} onQuery={(fleetQuery) => update({ fleetQuery }, true)}
        onFilter={(fleetFilter) => update({ fleetFilter })} />
    )
  } else if (activeSection === 'monitor') {
    content = (
      <VehicleMonitor
        selected={selected}
        mode={monitorMode}
        list={monitorList}
        onListChange={setMonitorList}
        onModeChange={setMonitorMode}
        onSelect={(id) => handleSelectVehicle(id, true)}
        onDrive={(id) => { setDriveVehicleId(id); setActiveSection('drive') }}
        onAlerts={openAlerts}
      />
    )
  } else if (activeSection === 'drive') {
    content = (
      <RemoteDriving vehicleId={driveVehicleId} list={driveList} onListChange={setDriveList}
        onEnter={setDriveVehicleId} onBack={() => setDriveVehicleId(null)}
        onMonitor={(id) => {
          setSelectedVehicleId(id)
          setMonitorMode('detail')
          setActiveSection('monitor')
        }} />
    )
  } else if (activeSection === 'alerts') {
    content = null
  } else {
    content = <TaskCenter vehicles={mock.vehicles.entries.map((entry) => ({ id: entry.vehicle_id, name: entry.name }))} />
  }

  return (
    <div className="min-h-screen bg-slate-950 text-slate-50 flex">
      <SideNav activeSection={activeSection} onChangeSection={handleChangeSection} />
      <div className="min-w-0 flex-1 flex flex-col overflow-hidden">
        <TopBar />
        <main className="flex-1 p-4 xl:p-6 overflow-hidden">
          {returnToAlerts && (activeSection === 'monitor' || activeSection === 'drive') &&
            <button type="button" onClick={() => { setActiveSection('alerts'); setReturnToAlerts(false) }}
              className="mb-3 rounded border border-sky-800 px-3 py-1.5 text-xs text-sky-200">← 返回告警处置</button>}
          {content}
          {!navigationError && mock.map && mock.vehicles.entries.length > 0 && <div hidden={activeSection !== 'alerts'} className="h-full min-h-0">
            <VehicleAlertCenter filters={alertFilters} section={alertSection} onSection={setAlertSection}
              onChange={setAlertFilters} onNavigate={(id) => {
                setAlertFilters((current) => ({ ...current, selectedVehicle: id }))
                setSelectedVehicleId(id)
                setMonitorMode('detail')
                setReturnToAlerts(true)
                setActiveSection('monitor')
              }} />
          </div>}
        </main>
      </div>
    </div>
  )
}

const PlaceholderSection: React.FC<{ title: string; description: string }> = ({ title, description }) => (
  <section role="status" className="space-y-2">
    <h1 className="text-sm font-semibold">{title}</h1>
    <p className="text-xs text-slate-400">{description}</p>
  </section>
)

export default HomePage
