import React, { useEffect, useRef, useState } from 'react'
import { useVehicleData } from '../hooks/use-vehicle-data'
import {
  acknowledgeDataEvent, createPreviewData, dataIdentifier, exportDataRecords,
  healthFreshness, newDataQuery, submitDataQuery,
} from '../lib/vehicle-data-api'
import type { DataTask, VehicleData } from '../lib/vehicle-data-api'

interface Props {
  vehicleId: string
  accessToken?: string
  preview?: boolean
  mode?: 'details' | 'alerts' | 'tasks'
}
const date = (value: number) => new Date(value).toLocaleString()
const box = 'rounded-lg border border-slate-800 bg-slate-950/50 p-3'
const button = 'rounded border border-sky-800 px-3 py-1 text-xs text-sky-200 disabled:opacity-40'
const input = 'rounded border border-slate-700 bg-slate-950 p-2 text-xs text-slate-100'
const statusLabels: Record<string, string> = {
  received: '设备已持久接收', reconciling: '已建立派发栅栏 · 等待结果',
  unknown: '结果未知 · 对账中', succeeded: '查询已回答 / 模拟已完成', rejected: '已拒绝',
}

const VehicleDataPanel: React.FC<Props> = ({ vehicleId, accessToken, preview = false, mode = 'details' }) => {
  const live = useVehicleData(vehicleId, accessToken, !preview)
  const data = preview ? createPreviewData(vehicleId) : live.data
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [epoch, setEpoch] = useState('')
  const [target, setTarget] = useState('')
  const [draft, setDraft] = useState<DataTask>()
  const request = useRef<AbortController | undefined>(undefined)
  useEffect(() => () => request.current?.abort(), [vehicleId, accessToken])
  useEffect(() => {
    if (!draft || !data || busy) return
    const persisted = data.tasks.some((task) => JSON.stringify(task.request) === JSON.stringify(draft))
    if (persisted) {
      setNotice(`查询 ${draft.request_id} 已在云端确认落库；不代表原任务完成。`)
      setDraft(undefined)
    }
  }, [data, draft, busy])
  const current = Boolean(data) && !live.error && !preview && live.elapsedMs <= 5000
  const manage = current && data?.can_manage && Boolean(accessToken)
  const health = data ? healthFreshness(data, preview ? 0 : live.elapsedMs) : undefined
  const act = async (operation: (signal: AbortSignal) => Promise<void>) => {
    if (!accessToken || preview || busy || request.current) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setError(''); setNotice('')
    try {
      await operation(controller.signal)
      if (!controller.signal.aborted) live.refresh()
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure instanceof Error ? failure.message : '操作失败')
    } finally {
      if (!controller.signal.aborted) {
        request.current = undefined
        setBusy(false)
      }
    }
  }
  const query = () => {
    if (!manage || !accessToken || !data?.profile || request.current) return
    const task = draft ?? newDataQuery(vehicleId, data.profile.payload.map_id, epoch, target)
    setDraft(task)
    void act(async (signal) => {
      await submitDataQuery(task, accessToken, signal)
      if (!signal.aborted) {
        setNotice(`查询 ${task.request_id} 已在云端持久化；不代表设备接收或任务完成。`)
        setDraft(undefined)
      }
    })
  }
  const download = (kind: 'events' | 'tasks') => {
    if (!accessToken) return
    void act(async (signal) => {
      const content = await exportDataRecords(vehicleId, kind, accessToken, signal)
      if (signal.aborted) return
      const url = URL.createObjectURL(new Blob([content], { type: 'application/x-ndjson' }))
      const anchor = document.createElement('a')
      anchor.href = url; anchor.download = `${vehicleId}-${kind}-${Date.now()}.ndjson`; anchor.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
      setNotice('导出完成；未删除服务器记录或去重身份。任务结果及人工确认是逐页读取，不是数据库一致性备份。')
    })
  }
  return (
    <section className="space-y-3 rounded-xl border border-slate-800 bg-slate-900/70 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm text-slate-100">车辆 {vehicleId} · {mode === 'tasks' ? '持久任务' : mode === 'alerts' ? 'Monitor 事件' : 'Monitor 健康与数据运维'}</h2>
        <span className="text-xs text-amber-200">{preview ? '固定预览 · 不执行操作' : current ? '业务接口在线（不代表车端在线）' : '缓存 / 未收到数据'}</span>
      </header>
      {live.loading && !preview && <p className="text-xs text-slate-400">正在读取常在线数据…</p>}
      {!accessToken && !preview && <p className="text-xs text-slate-400">登录后读取授权车辆数据。</p>}
      {(error || live.error) && !preview && <p role="alert" className="text-xs text-rose-300">{error || live.error}；缓存不能作为当前健康结论。</p>}
      {notice && <p role="status" className="text-xs text-sky-200">{notice}</p>}
      {data && <>
        <div className={box}>
          <p className="text-xs text-slate-200">
            {data.profile ? `${data.profile.payload.model || '未知车型'} · 软件 ${data.profile.payload.software_version || '未知'} · 地图 ${data.profile.payload.map_id || '未配置'}` : '尚未收到设备静态信息'}
          </p>
          <p className="mt-1 text-xs text-amber-200">
            Monitor：{!preview && current && health?.fresh ? '源数据新鲜' : preview ? '预览，非实时' : '未知 / 过期 / 不完整'}
            {health?.age != null && ` · 至少 ${(health.age / 1000).toFixed(1)} 秒`}
            {data.health?.payload.sample.message?.components_truncated && ' · 已截断，不推断恢复'}
          </p>
          {data.health?.payload.sample.message && <>
            <p className="mt-1 text-xs text-slate-400">Monitor 紧急停车要求：{data.health.payload.sample.message.require_emergency_stop === null ? '未知' : data.health.payload.sample.message.require_emergency_stop ? '是' : '否'}（仅状态，不是控制命令）</p>
            <p className="mt-1 text-xs text-slate-400">{data.health.payload.sample.message.passenger_msg}</p>
          </>}
          <HealthChecks data={data} />
        </div>
        <Capacity data={data} elapsedMs={live.elapsedMs} />
        {mode !== 'tasks' && <div className="space-y-2">
          <h3 className="text-xs text-slate-200">最近 {data.events.length} 条事件 · 人工确认不改变设备恢复状态</h3>
          {data.events.map((event) => {
            const ack = data.acknowledgements.find((value) => value.event_id === event.event_id)
            return <article className={box} key={event.event_id}>
              <p className="text-xs text-slate-200">{event.severity} · {event.fault_key} · {event.transition === 'recovered' ? '设备恢复' : event.transition === 'raised' ? '故障触发' : '严重度变化'}</p>
              <p className="mt-1 text-xs text-slate-400">{event.message} · {date(event.occurred_at_ms)}</p>
              <p className="mt-1 text-xs text-slate-500">{event.event_id}</p>
              {ack ? <p className="mt-2 text-xs text-sky-200">{ack.operator_id} 已确认 · {date(ack.acknowledged_at_ms)}</p>
                : <button className={`${button} mt-2`} disabled={!manage || busy} onClick={() => {
                  if (accessToken) void act(async (signal) => {
                    await acknowledgeDataEvent(vehicleId, event.event_id, accessToken, signal)
                    if (!signal.aborted) setNotice('人工确认已保存；设备故障状态没有被修改。')
                  })
                }}>确认已知悉</button>}
            </article>
          })}
          {!data.events.length && <p className="text-xs text-slate-500">尚无 Monitor 事件，不代表车辆健康。</p>}
        </div>}
        {mode === 'tasks' && <>
          <form className={`${box} flex flex-wrap gap-2`} onSubmit={(event) => { event.preventDefault(); query() }}>
            <p className="w-full text-xs text-amber-200">仅查询 Mission 原请求账本；不派发运动、取消、恢复或安全复位。设备仍需校验新鲜能力清单。</p>
            <input aria-label="目标 client_epoch" className={input} placeholder="目标 client_epoch" value={epoch} disabled={busy || Boolean(draft)} onChange={(e) => setEpoch(e.target.value)} />
            <input aria-label="目标 request_id" className={input} placeholder="目标 request_id" value={target} disabled={busy || Boolean(draft)} onChange={(e) => setTarget(e.target.value)} />
            <button type="submit" className={button} disabled={!manage || busy || data.profile?.payload.task_mode !== 'mission_query' ||
              !dataIdentifier.safeParse(epoch).success || !dataIdentifier.safeParse(target).success}>
              {draft ? '重试同一查询身份' : '创建只读查询'}
            </button>
            {draft && <p className="w-full text-xs text-amber-200">待核实请求 {draft.request_id}；重试保持原载荷与期限，不生成新身份。离开前请保存此 ID。</p>}
            {draft && <button type="button" className={button} disabled={busy} onClick={() => {
              if (window.confirm(`请求 ${draft.request_id} 可能已落库。请先核实任务列表；清除仅取消本地重试，不会取消服务端查询。`)) setDraft(undefined)
            }}>清除本地重试（不取消任务）</button>}
            {data.profile?.payload.task_mode !== 'mission_query' && <p className="w-full text-xs text-slate-500">设备未配置只读 Mission 查询模式。</p>}
          </form>
          {data.tasks.map(({ request: task, result }) => <article className={box} key={task.request_id}>
            <p className="text-xs text-slate-100">{task.operation === 'query' ? '只读查询' : '模拟等待'} · {task.request_id}</p>
            <p className="mt-1 text-xs text-amber-200">{result
              ? result.status === 'succeeded' ? task.operation === 'query' ? '查询已回答 · 不代表运动完成' : '模拟等待已完成'
                : statusLabels[result.status]
              : '仅云端已落库 · 尚无设备回执'}{result && ` · 报告 #${result.report_sequence}`}</p>
            <p className="mt-1 text-xs text-slate-400">{result?.reason} · 截止 {date(task.expires_at_ms)}</p>
            {result?.mission_result && <div className="mt-2 text-xs text-slate-400">
              <p>Mission：{result.mission_result.outcome} · {result.mission_result.code} · {result.mission_result.reason}</p>
              <p>重试建议：{result.mission_result.retry_disposition ?? '未知'} · commit {result.mission_result.commit_sequence ?? '未知'} · {result.mission_result.terminal_disposition ?? '终态未知'}</p>
              <p>查询成功仅表示账本已回答，不代表原任务运动完成。</p>
            </div>}
          </article>)}
          {!data.tasks.length && <p className="text-xs text-slate-500">尚无持久任务。</p>}
        </>}
        {!preview && <footer className="flex flex-wrap gap-2">
          <button className={button} disabled={busy || !current} onClick={() => download('events')}>导出全部保留事件</button>
          <button className={button} disabled={busy || !current} onClick={() => download('tasks')}>导出全部保留任务</button>
          <button className={button} disabled={busy} onClick={live.refresh}>刷新</button>
        </footer>}
      </>}
    </section>
  )
}

function HealthChecks({ data }: { data: VehicleData }) {
  const monitor = data.health?.payload.sample.message
  if (!monitor) return <p className="mt-2 text-xs text-slate-500">尚未收到 Monitor 样本。</p>
  const rows: { key: string; status: string | null; message: string | null }[] = []
  for (const [name, checks] of Object.entries(monitor.components)) {
    if (!checks) rows.push({ key: `components/${name}`, status: null, message: null })
    else for (const [check, value] of Object.entries(checks)) rows.push({ key: `components/${name}/${check}`, status: value?.status ?? null, message: value?.message ?? null })
  }
  for (const group of ['hmi_modules', 'other_components'] as const) {
    for (const [name, value] of Object.entries(monitor[group])) rows.push({ key: `${group}/${name}`, status: value?.status ?? null, message: value?.message ?? null })
  }
  return <div className="mt-2 max-h-56 space-y-1 overflow-y-auto">{rows.map((row) =>
    <p className="text-xs text-slate-400" key={row.key}>{row.key} · {row.status ?? '未知'} · {row.message}</p>)}</div>
}
function Capacity({ data, elapsedMs }: { data: VehicleData; elapsedMs: number }) {
  const cloud = data.capacity
  const device = data.diagnostics?.payload.store
  const future = data.diagnostics && (data.diagnostics.payload.published_at_ms > data.server_time_ms + 100 ||
    data.diagnostics.received_at_ms > data.server_time_ms + 100)
  const deviceAge = data.diagnostics
    ? Math.max(0, data.server_time_ms - data.diagnostics.payload.published_at_ms,
      data.server_time_ms - data.diagnostics.received_at_ms) + elapsedMs : null
  const warning = cloud.capacity_warning || (device && Math.max(device.outbox_retained, device.inbox_retained, device.faults_retained) >= device.capacity * 0.8)
  return <div className={box}>
    <p className="text-xs text-slate-200">容量与积压（保留记录不会自动删除）</p>
    <p className="mt-1 text-xs text-slate-400">云端事件 {cloud.events_retained}/{cloud.events_capacity} · 未确认 {cloud.events_unacknowledged} · 任务 {cloud.tasks_retained}/{cloud.tasks_capacity} · 待处理 {cloud.tasks_pending} · 未知 {cloud.tasks_unknown}</p>
    <p className="mt-1 text-xs text-slate-400">{device
      ? `设备 outbox ${device.outbox_retained}/${device.capacity}（待传 ${device.outbox_pending}）· inbox ${device.inbox_retained}/${device.capacity}（待对账 ${device.inbox_pending}）· 故障键 ${device.faults_retained}/${device.capacity} · ${future ? '诊断时钟异常' : `快照至少 ${((deviceAge ?? 0) / 1000).toFixed(1)} 秒前`}`
      : '尚无设备持久队列诊断，不能推断无积压。'}</p>
    {warning && <p role="alert" className="mt-2 text-xs text-rose-300">保留容量已达 80%；请导出并执行经审核的备份/归档流程，达到上限将拒绝新写入。勿直接删除数据库或去重身份。</p>}
  </div>
}
export default VehicleDataPanel
