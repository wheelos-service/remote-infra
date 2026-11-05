import { useAuth } from '../app/AuthProvider'
import { useVehicles } from '../hooks/use-vehicles'
import { hasVehicleContext } from '../lib/organization-context'

export default function TaskManagement() {
  const auth = useAuth()
  const vehicles = useVehicles(hasVehicleContext(auth.authorizationContext, auth.organizationId) ? auth.accessToken : undefined, auth.organizationId)
  return <section className="space-y-4 text-slate-100" data-testid="task-management">
    <header className="flex items-center justify-between gap-3">
      <h1 className="text-base font-semibold">任务管理</h1>
      <button type="button" disabled title="任务服务暂不可用"
        className="rounded bg-sky-600 px-4 py-2 text-xs disabled:opacity-40">创建任务</button>
    </header>
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-800 bg-slate-900/70 p-3">
      <input aria-label="搜索任务" placeholder="搜索任务编号或名称" disabled
        className="min-w-[220px] flex-1 rounded border border-slate-700 bg-slate-950 p-2 text-xs disabled:opacity-40" />
      <label className="text-xs text-slate-400">任务车辆
        <select aria-label="任务车辆" disabled title="任务服务暂不可用"
          className="ml-2 rounded border border-slate-700 bg-slate-950 p-2 disabled:opacity-40">
          <option value="">全部车辆</option>
          {vehicles.entries.map(entry => <option key={entry.vehicle_id} value={entry.vehicle_id}>{entry.name || entry.vehicle_id}</option>)}
        </select>
      </label>
    </div>
    {vehicles.error && <p role="alert" className="text-xs text-red-300">{vehicles.error}</p>}
    <section className="overflow-hidden rounded-xl border border-slate-800 bg-slate-900/70">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-slate-950/60 text-slate-400"><tr>
            {['任务', '车辆', '状态', '创建时间', '操作'].map(label => <th key={label} className="px-4 py-3 font-normal">{label}</th>)}
          </tr></thead>
          <tbody><tr><td colSpan={5} className="p-16 text-center text-slate-400"><p role="status">任务服务暂不可用</p></td></tr></tbody>
        </table>
      </div>
    </section>
  </section>
}
