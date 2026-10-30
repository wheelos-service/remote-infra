import React from 'react'
import { AlertTriangle, Clock3, Radio } from 'lucide-react'
import { useVehicleOperations } from '../hooks/use-vehicle-operations'
import type { VehicleOperationsState } from '../hooks/use-vehicle-operations'
import {
  conservativeAgeMs,
  createPreviewOperations,
  recentHistoryWithMarkers,
} from '../lib/vehicle-operations-api'
import type { VehicleOperations } from '../lib/vehicle-operations-api'
import { selectedPreviewScenario } from '../lib/preview-vehicles'
import VehicleDataPanel from './VehicleDataPanel'

export type OperationsPanelMode = 'details' | 'alerts' | 'tasks'

interface VehicleOperationsPanelProps {
  vehicleId: string
  accessToken?: string
  preview?: boolean
  mode?: OperationsPanelMode
}

function dateLabel(value: number | null | undefined): string {
  return value == null ? '未知' : new Date(value).toLocaleString()
}

function ageLabel(value: number | null): string {
  if (value === null) return '未知'
  return value < 1_000 ? `${value} ms` : `${(value / 1_000).toFixed(1)} s`
}

const VehicleOperationsPanel: React.FC<VehicleOperationsPanelProps> = ({
  vehicleId,
  accessToken,
  preview = false,
  mode = 'details',
}) => {
  const live = useVehicleOperations(vehicleId, accessToken, !preview)
  const data = preview ? createPreviewOperations(vehicleId, undefined, selectedPreviewScenario()) : live.data
  const operationsAge = live.requestStartedAtMs === undefined
    ? null
    : Math.max(0, (live.nowMs ?? performance.now()) - live.requestStartedAtMs)
  const snapshotFresh = !preview && Boolean(data) && !live.error &&
    operationsAge !== null && operationsAge <= 5_000

  if (mode === 'alerts') {
    return (
      <OperationsSection
        title={`车辆 ${vehicleId} · 告警事件`}
        state={live}
        preview={preview}
        snapshotFresh={snapshotFresh}
        operationsAgeMs={operationsAge}
        empty="当前数据源未提供告警事件。"
      >
        {data?.alerts.length ? (
          <div className="space-y-2">
            {data.alerts.map((alert) => (
              <article key={alert.event_id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-sm text-slate-100">
                    <AlertTriangle className="h-4 w-4 text-amber-300" />
                    {alert.code}
                    <span className="text-xs text-slate-400">{severityLabel(alert.severity)}</span>
                  </div>
                  <span className="text-xs text-slate-400">{dateLabel(alert.occurred_at_ms)}</span>
                </div>
                <p className="mt-2 text-xs text-slate-300">{alert.message}</p>
                <p className="mt-2 text-[11px] text-slate-500">
                  {alert.status === 'open' ? '未恢复' : `已恢复 · ${dateLabel(alert.resolved_at_ms)}`}
                </p>
              </article>
            ))}
          </div>
        ) : (
          <p className="py-3 text-xs text-slate-500">
            {preview ? '预览场景无更多告警。' : live.status === 'ready' ? '该车辆当前没有已记录告警。' : '未能读取告警数据。'}
          </p>
        )}
      </OperationsSection>
    )
  }

  if (mode === 'tasks') {
    return (
      <OperationsSection
        title={`车辆 ${vehicleId} · Mission 状态`}
        state={live}
        preview={preview}
        snapshotFresh={snapshotFresh}
        operationsAgeMs={operationsAge}
        empty="当前数据源未提供 Mission 记录。"
      >
        {data?.missions.length ? (
          <div className="space-y-2">
            {data.missions.map((mission) => (
              <article key={mission.mission_id} className="rounded-lg border border-slate-800 bg-slate-950/50 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-slate-100">
                  <span>{mission.mission_id}</span>
                  <span className="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-300">
                    {missionStatusLabel(mission.status)}
                  </span>
                </div>
                <p className="mt-2 text-xs text-slate-300">{mission.description || '无描述'}</p>
                <p className="mt-2 text-[11px] text-slate-500">最近更新：{dateLabel(mission.updated_at_ms)}</p>
              </article>
            ))}
          </div>
        ) : (
          <p className="py-3 text-xs text-slate-500">
            {preview ? '预览场景无更多 Mission。' : live.status === 'ready' ? '该车辆当前没有已记录 Mission。' : '未能读取 Mission 数据。'}
          </p>
        )}
        {data && (
          <p className="mt-3 text-xs text-amber-200/80">
            只读状态。任务创建、派发及取消能力尚未开放。
          </p>
        )}
      </OperationsSection>
    )
  }

  return (
    <div className="space-y-3">
      <VehicleDataPanel key={`${preview ? 'preview' : accessToken}:${vehicleId}`} vehicleId={vehicleId} accessToken={accessToken} preview={preview} />
      <OperationsSection
        title="底盘派生诊断与遥测历史（兼容接口）"
        state={live}
        preview={preview}
        snapshotFresh={snapshotFresh}
        operationsAgeMs={operationsAge}
        empty="该车辆尚无诊断或历史数据。"
      >
        {data && (
          <OperationsDetails
            data={data}
            requestStartedAtMs={preview ? undefined : live.requestStartedAtMs}
            nowMs={live.nowMs ?? performance.now()}
          />
        )}
      </OperationsSection>
    </div>
  )
}

const OperationsSection: React.FC<{
  title: string
  state: VehicleOperationsState
  preview: boolean
  snapshotFresh: boolean
  operationsAgeMs: number | null
  empty: string
  children?: React.ReactNode
}> = ({ title, state, preview, snapshotFresh, operationsAgeMs, empty, children }) => (
  <section className="rounded-xl border border-slate-800 bg-slate-900/70 p-4">
    <header className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
      <h2 className="text-sm font-medium text-slate-100">{title}</h2>
      <span className={`rounded-full border px-2 py-0.5 text-[10px] ${
        preview
          ? 'border-amber-700/60 bg-amber-950/30 text-amber-200'
          : snapshotFresh
            ? 'border-emerald-700/60 text-emerald-200'
            : 'border-slate-700 text-slate-400'
      }`}>
        {preview
          ? '预览场景 · 非实时'
          : state.error && state.data
            ? `读取失败 · 缓存快照 ${ageLabel(operationsAgeMs)}`
            : snapshotFresh
              ? `业务快照 · ${ageLabel(operationsAgeMs)} 前`
              : state.data
                ? `缓存快照 · ${ageLabel(operationsAgeMs)} 前`
                : '只读数据'}
      </span>
    </header>
    {!preview && state.status === 'loading' && (
      <p className="py-3 text-xs text-slate-400">正在读取车辆业务数据…</p>
    )}
    {!preview && state.error && (
      <div role="alert" className="mb-3 rounded-lg border border-rose-800/70 bg-rose-950/30 p-3 text-xs text-rose-200">
        <p>业务数据不可用：{state.error}</p>
        {state.data && (
          <p className="mt-1 text-rose-200/70">
            以下为最近一次成功读取的缓存数据，年龄至少 {ageLabel(operationsAgeMs)}；不能作为当前健康结论。
          </p>
        )}
      </div>
    )}
    {!preview && !state.data && state.status === 'disabled' && (
      <p className="py-3 text-xs text-slate-400">登录并选择授权车辆后读取业务数据。</p>
    )}
    {state.data?.server_time_ms != null && !preview && (
      <p className="mb-3 flex items-center gap-1.5 text-[11px] text-slate-500">
        <Clock3 className="h-3 w-3" />
        服务端快照时间：{dateLabel(state.data.server_time_ms)}
      </p>
    )}
    {preview && <p className="mb-3 text-[11px] text-amber-200/70">固定预览场景，不反映任何车辆当前状态。</p>}
    {children}
    {!children && !state.data?.alerts?.length && !state.data?.missions?.length && (
      <p className="py-3 text-xs text-slate-500">{empty}</p>
    )}
  </section>
)

const OperationsDetails: React.FC<{
  data: VehicleOperations
  requestStartedAtMs?: number
  nowMs: number
}> = ({ data, requestStartedAtMs, nowMs }) => (
  <div className="space-y-4">
    <section>
      <div className="flex items-center gap-2 text-xs font-medium text-slate-200">
        <Radio className="h-3.5 w-3.5 text-sky-300" />
        诊断摘要 · 来源：常在线遥测
      </div>
      <p className="mt-1 text-[11px] leading-5 text-slate-500">
        仅表示当前已采集的底盘/定位遥测检查；不代表完整 SystemStatus 或车端整体健康结论。
      </p>
      <div className="mt-2 grid grid-cols-2 gap-2 text-xs md:grid-cols-4">
        <DiagnosticValue label="底盘样本" value={data.diagnostics.chassis_received
          ? `已收到 · ${ageLabel(conservativeAgeMs(data.diagnostics.chassis_age_ms, requestStartedAtMs, nowMs))}`
          : '未收到'} />
        <DiagnosticValue label="定位样本" value={data.diagnostics.localization_received
          ? `已收到 · ${ageLabel(conservativeAgeMs(data.diagnostics.localization_age_ms, requestStartedAtMs, nowMs))}`
          : '未收到'} />
        <DiagnosticValue label="源时间戳" value={dateLabel(data.diagnostics.source_timestamp_ms)} />
        <DiagnosticValue label="已采集问题" value={String(data.diagnostics.issues.length)} />
      </div>
      {data.diagnostics.issues.length > 0 ? (
        <ul className="mt-2 space-y-1">
          {data.diagnostics.issues.map((issue, index) => (
            <li key={`${issue.code}-${index}`} className="rounded bg-slate-950/60 px-2 py-1.5 text-xs text-amber-200">
              {issue.severity === 'critical' ? '严重' : '警告'} · {issue.code} · {issue.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-xs text-slate-500">未报告遥测检查问题；未采集指标仍为未知。</p>
      )}
    </section>

    <section className="grid gap-3 md:grid-cols-2">
      <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
        <h3 className="mb-2 text-xs font-medium text-slate-200">告警（{data.alerts.length}）</h3>
        {data.alerts.length ? data.alerts.slice(0, 5).map((alert) => (
          <div key={alert.event_id} className="border-t border-slate-800 py-2 text-xs">
            <div className="flex justify-between gap-2 text-slate-300">
              <span>{alert.code} · {severityLabel(alert.severity)}</span>
              <span className="text-slate-500">{dateLabel(alert.occurred_at_ms)}</span>
            </div>
            <p className="mt-1 text-slate-400">{alert.message}</p>
          </div>
        )) : <p className="text-xs text-slate-500">无已记录事件，或数据源不可用。</p>}
      </div>
      <div className="rounded-lg border border-slate-800 bg-slate-950/40 p-3">
        <h3 className="mb-2 text-xs font-medium text-slate-200">任务状态（{data.missions.length}）</h3>
        {data.missions.length ? data.missions.slice(0, 5).map((mission) => (
          <div key={mission.mission_id} className="border-t border-slate-800 py-2 text-xs">
            <div className="flex justify-between gap-2 text-slate-300">
              <span>{mission.mission_id}</span>
              <span>{missionStatusLabel(mission.status)}</span>
            </div>
            <p className="mt-1 text-slate-400">{mission.description || '无描述'}</p>
          </div>
        )) : <p className="text-xs text-slate-500">无任务记录，或数据源不可用。</p>}
      </div>
    </section>

    <section>
      <h3 className="mb-1 text-xs font-medium text-slate-200">抽样历史（最近 {data.history.length} 条）</h3>
      <p className="mb-2 text-[10px] text-slate-500">
        最多返回 300 条最新样本，不是完整回放；序号缺口与流 ID 切换会单独标记。
      </p>
      {data.history.length ? (
        <div className="max-h-48 space-y-1 overflow-y-auto">
          {recentHistoryWithMarkers(data.history).map(({ sample, marker }) => (
            <div key={`${sample.stream_id}-${sample.sequence}-${sample.received_at_ms}`}>
              {marker && (
                <p className={`px-2 py-1 text-[10px] ${
                  marker.kind === 'stream' ? 'text-amber-200' : 'text-orange-200'
                }`}>
                  {marker.label}
                </p>
              )}
              <div className="grid grid-cols-2 gap-2 rounded bg-slate-950/50 px-2 py-1.5 text-[11px] text-slate-400 md:grid-cols-4">
                <span>流 {sample.stream_id} · #{sample.sequence}</span>
                <span>发布 {dateLabel(sample.published_at_ms)}</span>
                <span>底盘 {sample.chassis ? '有样本' : '未知'}</span>
                <span>定位 {sample.localization ? '有样本' : '未知'}</span>
              </div>
            </div>
          ))}
        </div>
      ) : <p className="text-xs text-slate-500">尚无持久化历史样本。</p>}
    </section>

    <p className="text-[11px] text-slate-500">
      能力：任务操作 {data.capabilities.mission_commands ? '可用' : '关闭'} · 地图投影 {data.capabilities.geographic_projection ? '可用' : '关闭'} · 驾驶 {data.capabilities.driving ? '可用' : '关闭'}
    </p>
  </div>
)

const DiagnosticValue: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="rounded bg-slate-950/60 p-2">
    <div className="text-[10px] text-slate-500">{label}</div>
    <div className="mt-1 text-xs text-slate-200">{value}</div>
  </div>
)

function severityLabel(value: string): string {
  return value === 'critical' ? '严重' : value === 'warning' ? '警告' : '信息'
}

function missionStatusLabel(value: string): string {
  const labels: Record<string, string> = {
    unknown: '未知',
    accepted: '已接受',
    running: '执行中',
    succeeded: '成功',
    failed: '失败',
    canceled: '已取消',
  }
  return labels[value] ?? value
}

export default VehicleOperationsPanel
