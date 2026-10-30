import React, { useEffect, useState } from 'react'
import { AlertTriangle, ClipboardList } from 'lucide-react'
import type { VehiclesState } from '../hooks/use-vehicles'
import VehicleDataPanel from './VehicleDataPanel'

interface VehicleBusinessPageProps {
  mode: 'alerts' | 'tasks'
  vehicles: VehiclesState
  accessToken?: string
  preview?: boolean
}

const VehicleBusinessPage: React.FC<VehicleBusinessPageProps> = ({
  mode,
  vehicles,
  accessToken,
  preview = false,
}) => {
  const [selectedVehicleId, setSelectedVehicleId] = useState('')

  useEffect(() => {
    if (!vehicles.entries.some((entry) => entry.vehicle_id === selectedVehicleId)) {
      setSelectedVehicleId(vehicles.entries[0]?.vehicle_id ?? '')
    }
  }, [selectedVehicleId, vehicles.entries])

  const title = mode === 'alerts' ? 'Monitor 告警事件' : '任务接收与只读查询'
  const Icon = mode === 'alerts' ? AlertTriangle : ClipboardList
  const selected = vehicles.entries.find((entry) => entry.vehicle_id === selectedVehicleId)

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <Icon className="h-4 w-4 text-sky-300" />
            <h1 className="text-lg font-semibold text-slate-100">{title}</h1>
            <span className="rounded-full border border-amber-700/60 bg-amber-950/30 px-2 py-0.5 text-[10px] text-amber-200">
              {mode === 'alerts' ? '人工确认不代表恢复' : '实车运动关闭'}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-400">
            {mode === 'alerts'
              ? 'Monitor 故障与恢复事件、人工确认和保留容量；操作仍受车辆 ACL 限制。'
              : '展示任务持久接收与对账过程；只开放 Mission 账本查询，不执行车辆运动。'}
          </p>
        </div>
        <div className="text-xs text-slate-400">
          {preview ? '预览场景 · 固定示例，非实时数据' : vehicles.status === 'ready'
            ? '按选中车辆读取业务数据'
            : vehicles.status === 'signed-out' ? '请先登录' : '车辆目录尚不可用'}
        </div>
      </header>

      {preview && (
        <div className="rounded-lg border border-amber-800/60 bg-amber-950/20 px-4 py-3 text-xs text-amber-100">
          此页面使用固定预览场景，通过与实时接口相同的数据解析器；不是当前告警或实际任务。
        </div>
      )}
      {!preview && vehicles.error && (
        <div role="alert" className="rounded-lg border border-rose-800/70 bg-rose-950/30 px-4 py-3 text-xs text-rose-200">
          车辆目录不可用：{vehicles.error}
        </div>
      )}
      {!preview && vehicles.status === 'signed-out' && (
        <div className="rounded-lg border border-slate-800 bg-slate-900/70 p-5 text-sm text-slate-300">
          登录后才能读取账号获授权的车辆业务记录。
        </div>
      )}
      <div className="grid min-h-0 flex-1 gap-4 lg:grid-cols-[minmax(220px,0.65fr)_minmax(0,1.8fr)]">
        <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-3">
          <h2 className="mb-2 text-xs font-medium text-slate-200">授权车辆</h2>
          {vehicles.entries.map((entry) => (
            <button
              type="button"
              key={entry.vehicle_id}
              onClick={() => setSelectedVehicleId(entry.vehicle_id)}
              aria-pressed={selectedVehicleId === entry.vehicle_id}
              className={`mb-1 w-full rounded-lg border px-3 py-2 text-left ${
                selectedVehicleId === entry.vehicle_id
                  ? 'border-sky-600/70 bg-sky-950/30'
                  : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'
              }`}
            >
              <span className="block truncate text-xs font-medium text-slate-100">{entry.name || entry.vehicle_id}</span>
              <span className="mt-1 block text-[10px] text-slate-500">{entry.vehicle_id}</span>
            </button>
          ))}
          {vehicles.entries.length === 0 && (
            <p className="py-3 text-xs text-slate-500">
              {vehicles.status === 'loading' ? '正在载入车辆目录…' : '没有可读取的车辆。'}
            </p>
          )}
        </section>
        {selected ? (
          <VehicleDataPanel
            key={`${preview ? 'preview' : accessToken}:${mode}:${selected.vehicle_id}`}
            vehicleId={selected.vehicle_id}
            accessToken={accessToken}
            preview={preview}
            mode={mode}
          />
        ) : (
          <section className="flex items-center justify-center rounded-xl border border-dashed border-slate-700 bg-slate-900/40 p-6 text-center text-sm text-slate-500">
            选择一辆授权车辆查看{mode === 'alerts' ? '告警记录' : '任务状态'}。
          </section>
        )}
      </div>
    </div>
  )
}

export default VehicleBusinessPage
