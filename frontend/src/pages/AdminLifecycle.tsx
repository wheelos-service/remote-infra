import React, { useEffect, useRef, useState } from 'react'
import { adminErrorMessage, fetchAdminContext, type ManagedPerson, type ManagedVehicle } from '../lib/admin-api'
import { changeLifecycle, createRotationTicket, fetchLifecycle, fetchRegistration, fetchAudit, reconcileLifecycle,
  type LifecycleAction, type LifecycleInput, type LifecycleOperation, type Registration, type AuditPage, type AuditFilters } from '../lib/lifecycle-api'
import { buildInstallationPackage, downloadInstallationPackage } from '../lib/installation-package'
import { teleopConfig } from '../lib/teleop-config'
import { fetchVehicle, type VehicleDirectoryEntry } from '../lib/vehicles-api'

const field = 'rounded border border-slate-600 bg-slate-950 p-2 text-sm'
const button = 'rounded border border-slate-600 px-3 py-2 text-sm disabled:opacity-40'
const actionLabels: Record<LifecycleAction, string> = { member_remove: '移除成员', member_rejoin: '重新加入（查看者 / none）', vehicle_remove: '移除车辆', vehicle_reactivate: '核实并重新加入车辆', credential_revoke: '吊销车辆凭据', credential_rotate: '替换已安装设备凭据', vehicle_transfer: '转移车辆（保持禁用）' }
const providerLabels: Record<LifecycleOperation['provider_status'], string> = { not_required: '无需提供方操作', pending: '本地已拒绝，等待提供方确认', failed: '本地已拒绝，提供方失败', manual_required: '本地已拒绝，需运维在提供方吊销', confirmed: '提供方已确认' }
const emptyFilters: AuditFilters = { actor: '', target: '', action: '', outcome: '', from: '', until: '' }

type Selection = { target: string; name: string; action: LifecycleAction }
export function AdminLifecycle({ orgId, token, people, vehicles, platformAdmin, onboardingEnabled, authorizationVersion, onChange }: {
  orgId: string; token: string; people: ManagedPerson[]; vehicles: ManagedVehicle[]; platformAdmin: boolean; onboardingEnabled: boolean; authorizationVersion: number; onChange: () => void
}) {
  const [operations, setOperations] = useState<LifecycleOperation[]>([])
  const [selection, setSelection] = useState<Selection>()
  const [reason, setReason] = useState('')
  const [subject, setSubject] = useState('')
  const [destination, setDestination] = useState('')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [busy, setBusy] = useState(false)
  const [revision, setRevision] = useState(0)
  const [version, setVersion] = useState(authorizationVersion)
  useEffect(() => { setVersion(authorizationVersion) }, [authorizationVersion])
  const [registration, setRegistration] = useState<Registration>()
  const [presence, setPresence] = useState<VehicleDirectoryEntry>()
  const [audit, setAudit] = useState<AuditPage>()
  const [filters, setFilters] = useState<AuditFilters>(emptyFilters)
  const [appliedFilters, setAppliedFilters] = useState<AuditFilters>(emptyFilters)
  const [cursor, setCursor] = useState('')
  const [auditVisible, setAuditVisible] = useState(false)
  const lifetime = useRef<AbortController | undefined>(undefined)
  const diagnostic = useRef<AbortController | undefined>(undefined)
  const pending = useRef<{ fingerprint: string; input: LifecycleInput } | undefined>(undefined)
  const saving = useRef(false)
  const operationState = useRef<string | undefined>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    return () => { controller.abort(); diagnostic.current?.abort(); pending.current = undefined }
  }, [orgId, token])
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const result = await fetchLifecycle(orgId, token, controller.signal)
        if (controller.signal.aborted) return
        setOperations(result)
        const state = JSON.stringify(result.map(op => [op.id, op.provider_status, op.installation_status]))
        if (operationState.current !== undefined && operationState.current !== state) onChange()
        operationState.current = state
        if (result.some(op => op.provider_status === 'pending' || ['pending', 'awaiting_install'].includes(op.installation_status))) timer = setTimeout(() => void load(), 5000)
      } catch (cause) { if (!controller.signal.aborted) setError(adminErrorMessage(cause)) }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [orgId, token, revision])
  useEffect(() => {
    setAudit(undefined)
    if (!auditVisible) return
    const controller = new AbortController()
    void fetchAudit(orgId, token, appliedFilters, cursor, controller.signal).then(result => {
      if (!controller.signal.aborted) setAudit(result)
    }).catch(cause => { if (!controller.signal.aborted) setError(adminErrorMessage(cause)) })
    return () => controller.abort()
  }, [orgId, token, auditVisible, appliedFilters, cursor, revision])
  const run = async (work: (signal: AbortSignal) => Promise<void>) => {
    const controller = lifetime.current
    if (!controller || saving.current) return
    saving.current = true; setBusy(true); setError(''); setNotice('')
    try { await work(controller.signal) }
    catch (cause) { if (!controller.signal.aborted) setError(adminErrorMessage(cause)) }
    finally { if (!controller.signal.aborted) { saving.current = false; setBusy(false); setRevision(v => v + 1) } }
  }
  const choose = (item: Selection) => {
    setSelection(item); setReason(''); setSubject(''); setDestination(''); pending.current = undefined; setError('')
  }
  const inspect = async (target: string, kind: 'person' | 'vehicle') => {
    diagnostic.current?.abort()
    const controller = new AbortController(); diagnostic.current = controller
    setRegistration(undefined); setPresence(undefined); setError('')
    try {
      const result = await fetchRegistration(orgId, token, target, kind, controller.signal)
      if (controller.signal.aborted) return
      setRegistration(result)
      if (kind === 'vehicle' && result.status === 'active') {
        try { const entry = await fetchVehicle(target, token, controller.signal); if (!controller.signal.aborted) setPresence(entry) }
        catch { if (!controller.signal.aborted) setPresence(undefined) }
      }
    } catch (cause) { if (!controller.signal.aborted) setError(adminErrorMessage(cause)) }
  }
  return <section className="space-y-4 rounded-xl border border-slate-800 p-5">
    <h2>访问生命周期与注册诊断</h2>
    <p className="text-sm text-amber-200">移除、重新加入与吊销需要维护排空。吊销后不允许直接重新激活旧凭据。重新加入车辆会适用当前 all 范围。</p>
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
    <details><summary>人员成员状态</summary><ul className="space-y-2">{people.map(person => <li key={person.user_id} className="flex flex-wrap items-center gap-2">
      <span>{person.name} · {person.status}</span>
      <button className={button} disabled={busy} onClick={() => void inspect(person.user_id, 'person')}>注册诊断</button>
      {(person.status === 'active' || person.status === 'removed') && <button className={button} disabled={busy} onClick={() => choose({ target: person.user_id, name: person.name, action: person.status === 'removed' ? 'member_rejoin' : 'member_remove' })}>{person.status === 'removed' ? '重新加入' : '移除成员'}</button>}
    </li>)}</ul></details>
    <details><summary>车辆访问状态</summary><ul className="space-y-2">{vehicles.map(vehicle => <li key={vehicle.vehicle_id} className="flex flex-wrap items-center gap-2">
      <span>{vehicle.name} · {vehicle.vehicle_id} · {vehicle.status}</span>
      <button className={button} disabled={busy} onClick={() => void inspect(vehicle.vehicle_id, 'vehicle')}>注册诊断</button>
      {vehicle.status === 'active' && <button className={button} disabled={busy} onClick={() => choose({ target: vehicle.vehicle_id, name: vehicle.name, action: 'vehicle_remove' })}>移除车辆</button>}
      {vehicle.status === 'disabled' && platformAdmin && <button className={button} disabled={busy} onClick={() => choose({ target: vehicle.vehicle_id, name: vehicle.name, action: 'vehicle_reactivate' })}>核实并重新加入</button>}
      {onboardingEnabled && <button className={button} disabled={busy} onClick={() => choose({ target: vehicle.vehicle_id, name: vehicle.name, action: 'credential_rotate' })}>替换凭据</button>}
      {platformAdmin && <button className={button} disabled={busy} onClick={() => choose({ target: vehicle.vehicle_id, name: vehicle.name, action: 'vehicle_transfer' })}>转移组织（保持禁用）</button>}
      <button className={button} disabled={busy} onClick={() => choose({ target: vehicle.vehicle_id, name: vehicle.name, action: 'credential_revoke' })}>吊销凭据</button>
    </li>)}</ul></details>
    {selection && <form className="space-y-3 rounded border border-amber-700 p-4" onSubmit={event => {
      event.preventDefault()
      void run(async signal => {
        const fingerprint = JSON.stringify({ selection, reason, subject, destination })
        if (pending.current?.fingerprint !== fingerprint) {
          pending.current = { fingerprint, input: { idempotency_key: crypto.randomUUID(), expected_version: version, reason,
            ...(['vehicle_reactivate', 'vehicle_transfer'].includes(selection.action) ? { verified_subject: subject } : {}),
            ...(selection.action === 'vehicle_transfer' ? { destination_org_id: destination } : {}) } }
        }
        const result = await changeLifecycle(orgId, token, selection.target, selection.action, pending.current.input, signal)
        if (signal.aborted) return
        pending.current = undefined; setSelection(undefined); setNotice(`已保存 ${result.id} · ${providerLabels[result.provider_status]}`)
        onChange()
      })
    }}>
      <p>{actionLabels[selection.action]}：{selection.name} · {selection.target} · 组织 {orgId}</p>
      <p>人员移除仅影响当前组织；重新加入不会恢复旧操作授权。凭据吊销会先拒绝本地访问，再协调提供方。</p>
      <label className="block">原因 <input className={field} required maxLength={500} value={reason} disabled={busy} onChange={e => setReason(e.target.value)} /></label>
      {['vehicle_reactivate', 'vehicle_transfer'].includes(selection.action) && <label className="block">已重新核实的可信 subject <input className={field} required maxLength={512} value={subject} disabled={busy} onChange={e => setSubject(e.target.value)} /></label>}
      {selection.action === 'vehicle_transfer' && <label className="block">目标组织 UUID <input className={field} required value={destination} onChange={e => setDestination(e.target.value)} /></label>}
      <button className={button} disabled={busy} type="submit">确认提交</button>
      <button className={button} disabled={busy} type="button" onClick={() => { pending.current = undefined; setSelection(undefined) }}>取消</button>
      <button className={button} disabled={busy} type="button" onClick={() => void run(async signal => { const context = await fetchAdminContext(token, signal); if (!signal.aborted) { pending.current = undefined; setVersion(context.authorization_version ?? 0); setNotice('已更新提交版本；请核对当前目录与操作历史，再重新确认。'); onChange() } })}>核对状态并重新确认版本</button>
    </form>}
    {registration && <article className="space-y-1 rounded border border-slate-700 p-3 text-sm">
      <p>{registration.target_id} · 成员/车辆 {registration.status} · 绑定 {registration.binding_status}</p>
      <p>接入 {registration.provisioning_status} · 阶段 {registration.stage} · {registration.updated_at ?? '暂无自动接入时间'}</p>
      <p>operation_id: {registration.operation_id || '手工预配'} · {registration.error_code}</p>
      {registration.kind === 'person' ? <p>首次成功 Gateway 认证请求：{registration.first_authenticated_at ?? '尚未观察到'}。邀请成功不代表邮件送达或密码设置；此时间不是 IdP 登录时间。</p> : <>
        <p>数据在线状态：{presence ? presence.online ? '在线' : '离线/过期' : '未知或不可用'} · 最后接收：{presence?.received_at_ms ? new Date(presence.received_at_ms).toISOString() : '未知'}</p>
        <p>认证安装、在线、视频与驾驶就绪分别判断。请在授权监看页面查看实时健康和视频状态。</p>
      </>}
    </article>}
    <details><summary>生命周期操作（最近 100 项）</summary>
      {operations.map(op => <article className="my-2 rounded border border-slate-700 p-3 text-sm" key={op.id}>
        <p>{op.action} · {op.target_id} · {providerLabels[op.provider_status]}</p><p>替换安装：{op.installation_status || '不适用'}</p><p>{op.reason} · {op.updated_at} · {op.error_code}</p><p>operation_id: {op.id}</p>
        {op.installation_status === 'awaiting_install' && <>
          <p>停止设备服务，将旧配置移至受保护备份后再安装。工具不会覆盖已有文件；完成激活仍需维护排空。下载后 chmod 600。若已兑换但配置响应丢失，请发起新的替换操作；不得复用该身份重领。</p>
          <button className={button} disabled={busy} onClick={() => void run(async signal => {
            const ticket = await createRotationTicket(orgId, token, op.id, signal)
            if (!signal.aborted) downloadInstallationPackage(buildInstallationPackage(ticket, op.target_id, op.id, teleopConfig.gatewayUrl), op.target_id)
          })}>轮换并下载替换安装包</button>
        </>}
        {(op.provider_status === 'failed' || op.installation_status === 'failed' || op.provider_status === 'manual_required' && platformAdmin) && <form onSubmit={event => {
          event.preventDefault(); const explanation = String(new FormData(event.currentTarget).get('reason') ?? '')
          void run(async signal => { await reconcileLifecycle(orgId, token, op.id, op.provider_status === 'failed' || op.installation_status === 'failed' ? 'retry' : 'confirm', explanation, signal); if (!signal.aborted) { setNotice('已保存协调操作。'); onChange() } })
        }}>
          <label>核实记录/重试原因 <input name="reason" className={field} required maxLength={500} disabled={busy} /></label>
          <button className={button} disabled={busy}>{op.provider_status === 'failed' || op.installation_status === 'failed' ? '手动重试提供方' : '确认已在提供方完成吊销'}</button>
        </form>}
      </article>)}
    </details>
    <button className={button} onClick={() => { setAuditVisible(v => !v); setCursor('') }}>操作审计</button>
    {auditVisible && <div className="space-y-3">
      <form className="flex flex-wrap gap-2" onSubmit={event => { event.preventDefault(); setCursor(''); setAppliedFilters({ ...filters }) }}>
        {(['actor', 'target', 'action', 'from', 'until'] as const).map(key => <label key={key}>{key}<input className={field} value={filters[key]} maxLength={128} placeholder={key === 'from' || key === 'until' ? 'RFC3339 UTC 时间' : ''} onChange={e => setFilters(value => ({ ...value, [key]: e.target.value }))} /></label>)}
        <label>结果 <select className={field} value={filters.outcome} onChange={e => setFilters(value => ({ ...value, outcome: e.target.value }))}><option value="">全部</option><option value="applied">已应用</option><option value="failed">失败事件</option></select></label>
        <button className={button}>筛选</button>
      </form>
      {!audit ? <p role="status">{error ? '审计尚未加载，请检查筛选条件后重试。' : '加载审计…'}</p> : <><ul>{audit.items.map(entry => <li className="my-2 border-b border-slate-800 py-2 text-sm" key={entry.id}>{entry.created_at} · {entry.action} · {entry.actor_user_id} · 版本 {entry.authorization_version}<pre className="whitespace-pre-wrap break-all">{JSON.stringify(entry.details, null, 2)}</pre></li>)}</ul>
        {!audit.items.length && <p>暂无匹配审计记录。</p>}
        <button className={button} disabled={!cursor} onClick={() => setCursor('')}>首页</button>
        <button className={button} disabled={!audit.next_cursor} onClick={() => setCursor(audit.next_cursor)}>下一页</button></>}
    </div>}
  </section>
}
