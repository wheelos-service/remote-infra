import { useAuth } from '../app/AuthProvider'
import { useOperationsNavigation } from '../app/useOperationsNavigation'
import { OperationsShell } from '../features/layout/OperationsLayout'
import { hasVehicleContext, organizationRoleLabels } from '../lib/organization-context'
import { AuthorizedVehicleContent } from './LiveDriving'
import TaskManagement from './TaskManagement'
import { UnavailableVehicleAlertCenter } from './VehicleAlertCenter'

export default function OperationsPlatform() {
  const auth = useAuth()
  const { state: route, update, error } = useOperationsNavigation()
  const organization = auth.organizations.find(org => org.org_id === auth.organizationId)
  return <OperationsShell activeSection={route.page} onChangeSection={page => {
      if (!auth.controlBusy) update({ page, vehicle: '', driveVehicle: '', view: 'list' })
    }} topBar={
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-slate-800 p-4 text-sm">
        <div className="flex flex-wrap items-center gap-3">
          {auth.authorizationContext?.mode === 'static' ? <span>静态授权</span> : <label>当前组织 <select aria-label="当前组织" className="rounded border border-slate-700 bg-slate-900 p-2"
            value={auth.organizationId} disabled={auth.controlBusy || !auth.organizations.length} onChange={event => {
              auth.selectOrganization(event.target.value)
              update({ vehicle: '', driveVehicle: '', view: 'list' })
            }}>
            {!auth.organizations.length && <option value="">尚无可用组织</option>}
            {auth.organizations.map(org => <option key={org.org_id} value={org.org_id}>{org.name}</option>)}
          </select></label>}
          {organization && <span>{organizationRoleLabels[organization.role]}</span>}
        </div>
        <div className="flex gap-4">
          {organization?.can_manage && <a href="#/admin" aria-disabled={auth.controlBusy} onClick={event => {
            if (auth.controlBusy) event.preventDefault()
          }}>组织管理</a>}
          <span>{auth.operator?.Name}</span>
          {auth.accessToken && <button disabled={auth.controlBusy} onClick={auth.signOut}>退出登录</button>}
        </div>
      </header>}>
      <div className="space-y-4">
        {auth.controlBusy && <p role="status" className="text-amber-200">控制会话正在进行；请先安全释放并确认交接，再切换页面、组织或退出登录。</p>}
        {auth.error && <p role="alert" className="text-red-300">{auth.error}</p>}
        {error && <p role="alert">{error}</p>}
        {!auth.accessToken ? <section className="space-y-4 rounded-xl border border-slate-800 p-8">
          <h1 className="text-xl">登录组织运营平台</h1>
          <p>使用组织账号登录，选择组织后访问获授权车辆。无模拟数据回退。</p>
          <button disabled={auth.loading} className="rounded bg-sky-600 px-4 py-2" onClick={() => void auth.signIn()}>组织账号登录</button>
          {auth.isDevLoginAvailable && <button className="ml-4" onClick={() => void auth.signInWithDevToken()}>本机开发令牌登录</button>}
        </section> : !hasVehicleContext(auth.authorizationContext, auth.organizationId) ? <section className="space-y-3">
          <p>没有可用组织或组织上下文尚未加载。请联系组织管理员加入组织；不会显示其他租户数据。</p>
          <button onClick={auth.refreshOrganizations}>刷新组织</button>
        </section> : route.page === 'alerts' ? <UnavailableVehicleAlertCenter />
          : route.page === 'tasks' ? <TaskManagement key={auth.organizationId} />
          : <AuthorizedVehicleContent key={auth.organizationId} section={route.page} selected={route.page === 'drive' ? route.driveVehicle : route.vehicle}
            onSelect={id => update(route.page === 'drive' ? { driveVehicle: id } : { vehicle: id, view: id ? 'detail' : 'list' })}
            onMonitor={id => update({ page: 'monitor', vehicle: id, view: 'detail' })}
            onDrive={id => update({ page: 'drive', driveVehicle: id })}
            onAlerts={() => update({ page: 'alerts' })}
            query={route.page === 'fleet' ? route.fleetQuery : route.page === 'monitor' ? route.monitorQuery : route.driveQuery}
            filter={route.page === 'fleet' ? route.fleetFilter : route.page === 'monitor' ? route.monitorFilter : route.driveFilter}
            onQuery={value => update(route.page === 'fleet' ? { fleetQuery: value } : route.page === 'monitor' ? { monitorQuery: value } : { driveQuery: value }, true)}
            onFilter={value => update(route.page === 'fleet' ? { fleetFilter: value === 'alerts' ? 'all' : value }
              : route.page === 'monitor' ? { monitorFilter: value === 'attention' ? 'all' : value }
                : { driveFilter: value === 'offline' ? 'offline' : 'all' })} />}
      </div>
  </OperationsShell>
}
