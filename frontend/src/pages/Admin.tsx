import React, { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { Car, Users, ShieldCheck, Plus, Search, RefreshCw, ArrowLeft, LogOut, Copy } from 'lucide-react'
import { useAuth } from '../app/AuthProvider'
import {
  adminErrorMessage, createAdminPerson, createAdminVehicle, fetchAdminContext, fetchAdminPeople,
  fetchAdminVehicles, saveAdminAssignment, type AdminContext, type Assignment, type ManagedPerson, type ManagedVehicle,
  createOnboarding, fetchOnboardingOperations, retryOnboarding,
  onboardingInputSchema, onboardingNeedsPolling, onboardingStatusLabel, registrationLinkAvailable,
  type OnboardingInput, type OnboardingOperation, type InstallationTicket,
  addExistingMember,
  lookupDeviceEnrollment, approveDeviceEnrollment, denyDeviceEnrollment, enrollmentUserCodeSchema, deviceEnrollmentApprovalSchema,
  type DeviceEnrollment,
  fetchRegistrationLink, type RegistrationLink,
} from '../lib/admin-api'

const fieldClass = 'w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-slate-100 outline-none focus:border-sky-400 focus:ring-2 focus:ring-sky-400/20'
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-lg border border-slate-600 px-3 py-2 text-sm transition hover:border-sky-400 hover:bg-slate-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400 disabled:cursor-not-allowed disabled:opacity-40'
const primaryButtonClass = `${buttonClass} border-sky-500 bg-sky-600 font-medium text-white hover:bg-sky-500`
type AdminTab = 'vehicles' | 'people' | 'permissions'
const adminTabs = [
  { id: 'vehicles', label: '车辆管理', icon: Car },
  { id: 'people', label: '人员管理', icon: Users },
  { id: 'permissions', label: '权限管理', icon: ShieldCheck },
] as const
const roleLabels: Record<string, string> = { viewer: '查看者', remote_operator: '操作员', org_admin: '管理员' }
const scopeLabels: Record<string, string> = { none: '无操作权限', all: '组织全部车辆', selected: '指定车辆' }

export function AdminTabs({ value, onChange, peopleCount, vehicleCount }: {
  value: AdminTab; onChange: (tab: AdminTab) => void; peopleCount: number; vehicleCount: number
}) {
  return <div role="tablist" aria-label="管理分类" className="grid grid-cols-3 gap-1 border-b border-slate-800 sm:flex sm:gap-2">
    {adminTabs.map(({ id, label, icon: Icon }, index) => <button key={id} id={`admin-tab-${id}`}
      type="button" role="tab" aria-selected={value === id} aria-controls={`admin-panel-${id}`}
      tabIndex={value === id ? 0 : -1}
      className={`inline-flex items-center justify-center gap-2 border-b-2 px-2 py-4 text-xs font-medium outline-none focus-visible:bg-slate-800 sm:px-4 sm:text-sm ${value === id ? 'border-sky-400 text-sky-300' : 'border-transparent text-slate-400 hover:text-slate-100'}`}
      onClick={() => onChange(id)} onKeyDown={event => {
        const next = event.key === 'ArrowRight' ? (index + 1) % adminTabs.length
          : event.key === 'ArrowLeft' ? (index + adminTabs.length - 1) % adminTabs.length
            : event.key === 'Home' ? 0 : event.key === 'End' ? adminTabs.length - 1 : undefined
        if (next === undefined) return
        event.preventDefault()
        onChange(adminTabs[next].id)
        document.getElementById(`admin-tab-${adminTabs[next].id}`)?.focus()
      }}>
      <Icon size={17} aria-hidden="true" />{label}
      {id !== 'permissions' && <span className="hidden rounded-md bg-slate-800 px-2 py-0.5 text-xs sm:inline-flex">{id === 'people' ? peopleCount : vehicleCount}</span>}
    </button>)}
  </div>
}

export function AdminDirectory({ tab, people, vehicles, query, onEdit }: {
  tab: AdminTab; people: ManagedPerson[]; vehicles: ManagedVehicle[]; query: string; onEdit: (userId: string) => void
}) {
  const search = query.trim().toLocaleLowerCase()
  const filteredVehicles = vehicles.filter(item => `${item.name} ${item.vehicle_id}`.toLocaleLowerCase().includes(search))
  const filteredPeople = people.filter(item => `${item.name} ${item.user_id} ${roleLabels[item.role ?? ''] ?? ''}`.toLocaleLowerCase().includes(search))
  const count = tab === 'vehicles' ? filteredVehicles.length : filteredPeople.length
  if (!count) return <div className="rounded-xl border border-dashed border-slate-700 px-6 py-12 text-center">
    <p className="font-medium">{search ? '没有匹配的记录' : tab === 'vehicles' ? '还没有登记车辆' : '还没有组织人员'}</p>
    <p className="mt-2 text-sm text-slate-400">{search ? '尝试其他名称或编号，或清空搜索。' : tab === 'vehicles' ? '填写车辆名称和车端生成的机器码，完成注册。' : '填写用户名和角色，复制注册链接发送给用户。'}</p>
  </div>
  return <div className="overflow-x-auto rounded-xl border border-slate-800">
    <table className="w-full min-w-[700px] text-left text-sm">
      <caption className="sr-only">{tab === 'vehicles' ? '车辆登记列表' : tab === 'people' ? '组织人员列表' : '人员权限列表'}</caption>
      <thead className="bg-slate-900 text-xs text-slate-400"><tr>
        <th scope="col" className="px-5 py-3">{tab === 'vehicles' ? '车辆 / 唯一编号' : '人员'}</th>
        <th scope="col" className="px-5 py-3">登记状态</th>
        {tab !== 'vehicles' && <><th scope="col" className="px-5 py-3">角色</th><th scope="col" className="px-5 py-3">操作车辆范围</th></>}
        <th scope="col" className="px-5 py-3">{tab === 'vehicles' ? '身份信息' : '操作'}</th>
      </tr></thead>
      <tbody className="divide-y divide-slate-800">
        {tab === 'vehicles' ? filteredVehicles.map(vehicle => <tr key={vehicle.vehicle_id} className="hover:bg-slate-900/60">
          <th scope="row" className="px-5 py-4 font-normal"><p className="font-medium text-slate-100">{vehicle.name}</p><p className="mt-1 break-all font-mono text-xs text-slate-400">{vehicle.vehicle_id}</p></th>
          <td className="px-5 py-4"><DirectoryStatus value={vehicle.status} /></td>
          <td className="px-5 py-4"><details className="text-xs text-slate-400"><summary className="cursor-pointer">查看绑定</summary><p className="mt-2 max-w-xs break-all">subject: {vehicle.subject}</p></details></td>
        </tr>) : filteredPeople.map(person => <tr key={person.user_id} className="hover:bg-slate-900/60">
          <th scope="row" className="px-5 py-4 font-normal"><p className="font-medium text-slate-100">{person.name}</p><details className="mt-1 text-xs text-slate-400"><summary className="cursor-pointer">身份详情</summary><p className="mt-2 max-w-xs break-all">ID: {person.user_id}<br />subject: {person.subject}</p></details></th>
          <td className="px-5 py-4"><DirectoryStatus value={person.status} /></td>
          <td className="px-5 py-4">{roleLabels[person.role ?? ''] ?? '未分配角色'}</td>
          <td className="max-w-xs px-5 py-4"><span className={person.scope === 'none' || !person.scope ? 'text-slate-400' : 'text-sky-200'}>{scopeLabels[person.scope ?? ''] ?? '无操作权限'}</span>
            {person.scope === 'selected' && <p className="mt-1 break-words text-xs text-slate-400">{(person.vehicle_ids ?? []).map(id => vehicles.find(item => item.vehicle_id === id)?.name ?? id).join('、')}</p>}</td>
          <td className="px-5 py-4"><button className={buttonClass} onClick={() => onEdit(person.user_id)} aria-label={`配置 ${person.name} 的权限`}>配置权限</button></td>
        </tr>)}
      </tbody>
    </table>
  </div>
}

function DirectoryStatus({ value }: { value: string }) {
  return <span className={`inline-flex rounded-full px-2 py-1 text-xs ${value === 'active' ? 'bg-emerald-500/10 text-emerald-300' : 'bg-slate-800 text-slate-300'}`}>{value === 'active' ? '已启用' : value === 'disabled' ? '已停用' : value}</span>
}

export function AdminNotice({ error }: { error: string }) {
  return <p role="alert" className="break-words text-sm text-red-300">{error}</p>
}

export function RoleRangeFields({ role, scope, vehicleIds, vehicles, onRole, onScope, onVehicles, platformAdmin = true }: {
  role: Assignment['role']; scope: Assignment['scope']; vehicleIds: string[]; vehicles: ManagedVehicle[]
  onRole: (role: Assignment['role']) => void; onScope: (scope: Assignment['scope']) => void
  onVehicles: (ids: string[]) => void; platformAdmin?: boolean
}) {
  return <>
    <label>固定角色 <select className={fieldClass} value={role} onChange={event => {
      const nextRole = event.target.value as Assignment['role']
      onRole(nextRole)
      if (nextRole === 'org_admin') onScope('all')
      else if (role === 'org_admin') { onScope('none'); onVehicles([]) }
    }}>
      {platformAdmin && <option value="org_admin">管理员</option>}
      <option value="viewer">查看者</option>
      <option value="remote_operator">操作员（远程驾驶）</option>
    </select></label>
    <label>操作车辆范围 <select className={fieldClass} disabled={role === 'org_admin'} value={scope} onChange={event => {
      const nextScope = event.target.value as Assignment['scope']
      onScope(nextScope)
      if (nextScope !== 'selected') onVehicles([])
    }}>
      <option value="none">none · 无操作权限（默认）</option>
      <option value="selected">selected · 指定车辆</option><option value="all">all · 组织全部车辆</option>
    </select></label>
    <p className="text-sm text-slate-400">所有有效组织成员默认可查看本组织全部有效车辆及实时视频，包括新增车辆。操作车辆范围仅限定显式授予的操作权限，查看者无论范围都不能控制。</p>
    {scope === 'none' && <p className="text-sm text-slate-400">默认无驾驶、控制或任务执行权限；后续可显式分配操作车辆范围。</p>}
    {role === 'org_admin' && <p className="text-sm text-slate-400">组织管理员使用 all 管理范围，可监看本组织车辆；管理员角色不授予控制或任务执行权限。</p>}
    {scope === 'selected' && <fieldset className="space-y-2">
      <legend>指定车辆（至少一辆）</legend>
      {vehicles.map(vehicle => <label key={vehicle.vehicle_id} className="block">
        <input type="checkbox" checked={vehicleIds.includes(vehicle.vehicle_id)} onChange={event =>
          onVehicles(event.target.checked ? [...vehicleIds, vehicle.vehicle_id] : vehicleIds.filter(id => id !== vehicle.vehicle_id))} />
        {' '}{vehicle.name} ({vehicle.vehicle_id}) · {vehicle.status}
      </label>)}
      {!vehicles.length && <p>此组织尚无已登记车辆。</p>}
    </fieldset>}
  </>
}

export function AdminForms({ platformAdmin, people, vehicles, disabled, onPerson, onVehicle, onAssignment, onboardingEnabled = false, section = 'all', initialUserId = '' }: {
  platformAdmin: boolean; people: ManagedPerson[]; vehicles: ManagedVehicle[]; disabled: boolean
  onPerson: (input: { name: string; subject: string }) => void
  onVehicle: (input: { vehicle_id: string; name: string; subject: string }) => void
  onAssignment: (input: Assignment) => void
  onboardingEnabled?: boolean
  section?: AdminTab | 'all'; initialUserId?: string
}) {
  const selectedPerson = people.find(person => person.user_id === initialUserId)
  const [userId, setUserId] = useState(initialUserId)
  const [role, setRole] = useState<Assignment['role']>(selectedPerson?.role === 'org_admin' || selectedPerson?.role === 'remote_operator' ? selectedPerson.role : 'viewer')
  const [scope, setScope] = useState<Assignment['scope']>(selectedPerson?.role === 'org_admin' || selectedPerson?.scope === 'all' ? 'all' : selectedPerson?.scope === 'selected' ? 'selected' : 'none')
  const [vehicleIds, setVehicleIds] = useState<string[]>(selectedPerson?.vehicle_ids ?? [])
  return <div className="space-y-6">
    {!onboardingEnabled && (platformAdmin ? <div className="grid gap-6 md:grid-cols-2">
      {(section === 'all' || section === 'people') && <form className="space-y-3" onSubmit={event => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        onPerson({ name: String(data.get('name')).trim(), subject: String(data.get('subject')).trim() })
      }}>
        <h2>绑定已预配的人员身份</h2>
        <fieldset disabled={disabled} className="flex flex-col gap-2">
          <label>人员名称 <input className={fieldClass} name="name" required maxLength={200} /></label>
          <label>已核实的 Casdoor subject <input className={fieldClass} name="subject" required autoComplete="off" /></label>
          <button className={buttonClass} type="submit">创建人员绑定</button>
        </fieldset>
      </form>}
      {(section === 'all' || section === 'vehicles') && <form className="space-y-3" onSubmit={event => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        onVehicle({ vehicle_id: String(data.get('vehicle_id')).trim(), name: String(data.get('name')).trim(), subject: String(data.get('subject')).trim() })
      }}>
        <h2>绑定已预配的车辆身份</h2>
        <fieldset disabled={disabled} className="flex flex-col gap-2">
          <label>车辆 ID <input className={fieldClass} name="vehicle_id" required pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,63}" /></label>
          <label>车辆名称 <input className={fieldClass} name="name" required maxLength={200} /></label>
          <label>已核实的 Casdoor subject <input className={fieldClass} name="subject" required autoComplete="off" /></label>
          <button className={buttonClass} type="submit">创建车辆绑定</button>
        </fieldset>
      </form>}
    </div> : <p className="text-sm text-amber-200">组织管理员仅能为已有身份分配权限。创建人员/车辆的 subject 绑定必须由平台管理员执行。</p>)}
    {(section === 'all' || section === 'permissions') && <form className="space-y-3" onSubmit={event => {
      event.preventDefault()
      onAssignment({ user_id: userId, role, scope, vehicle_ids: scope === 'all' ? [] : vehicleIds })
    }}>
      <h2>人员权限分配</h2>
      <p className="text-sm text-amber-200">禁止修改自己的权限；最后一位组织管理员保护由后端强制检查。org_admin 不自动获得驾驶权限。</p>
      <fieldset disabled={disabled} className="flex flex-col gap-3">
        <label>人员 <select required className={fieldClass} value={userId} onChange={event => {
          const id = event.target.value
          const person = people.find(item => item.user_id === id)
          setUserId(id)
          setRole(person?.role === 'org_admin' || person?.role === 'remote_operator' ? person.role : 'viewer')
          setScope(person?.role === 'org_admin' || person?.scope === 'all' ? 'all' : person?.scope === 'selected' ? 'selected' : 'none')
          setVehicleIds(person?.vehicle_ids ?? [])
        }}>
          <option value="">选择已有人员</option>
          {people.map(person => <option key={person.user_id} value={person.user_id}>{person.name} · {roleLabels[person.role ?? ''] ?? '未分配角色'} ({person.user_id.slice(0, 8)})</option>)}
        </select></label>
        <RoleRangeFields role={role} scope={scope} vehicleIds={vehicleIds} vehicles={vehicles}
          onRole={setRole} onScope={setScope} onVehicles={setVehicleIds} platformAdmin={platformAdmin} />
        <button type="submit" className={primaryButtonClass} disabled={!userId || (scope === 'selected' && !vehicleIds.length)}>保存权限分配</button>
      </fieldset>
    </form>}
  </div>
}

export function OnboardingForms({ platformAdmin, disabled, onSubmit, kind }: {
  platformAdmin: boolean; vehicles: ManagedVehicle[]; disabled: boolean
  onSubmit: (input: OnboardingInput, idempotencyKey: string) => Promise<boolean>
  kind?: OnboardingInput['kind']
}) {
  const [role, setRole] = useState<Assignment['role']>('viewer')
  const scope = role === 'org_admin' ? 'all' : 'none'
  const [error, setError] = useState('')
  const submissions = useRef(new Map<string, { fingerprint: string; key: string }>())
  const submitting = useRef(false)
  const submit = async (input: unknown) => {
    if (disabled || submitting.current) return
    const parsed = onboardingInputSchema.safeParse(input)
    if (!parsed.success) { setError(parsed.error.issues[0]?.message || '请检查接入信息。'); return }
    setError('')
    const fingerprint = JSON.stringify(parsed.data)
    let submission = submissions.current.get(parsed.data.kind)
    if (submission?.fingerprint !== fingerprint) {
      submission = { fingerprint, key: crypto.randomUUID() }
      submissions.current.set(parsed.data.kind, submission)
    }
    submitting.current = true
    try {
      // Retain the same key after an uncertain response; a repeated submission must not create another identity.
      if (await onSubmit(parsed.data, submission.key)) submissions.current.delete(parsed.data.kind)
    } finally { submitting.current = false }
  }
  return <section className="space-y-3">
    {error && <AdminNotice error={error} />}
    {kind !== 'vehicle' && <p className="text-sm text-slate-400">用户通过链接在 Casdoor 设置密码并完成注册。</p>}
    <div className={kind ? 'max-w-xl' : 'grid gap-6 md:grid-cols-2'}>
      {kind !== 'vehicle' && <form className="space-y-3" onSubmit={event => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        void submit({ kind: 'person', name: String(data.get('name') ?? ''), role, scope, vehicle_ids: [] })
      }}>
        <h2>添加人员</h2>
        <fieldset disabled={disabled} className="flex flex-col gap-3">
          <label>用户名 <input className={fieldClass} name="name" required minLength={2} maxLength={64} autoComplete="off"
            pattern={'[A-Za-z][A-Za-z0-9]*([_\\-][A-Za-z0-9]+)*'} placeholder="例如 operator-01" /></label>
          <label>角色 <select className={fieldClass} value={role} onChange={event => setRole(event.target.value as Assignment['role'])}>
            <option value="org_admin" disabled={!platformAdmin}>管理员</option>
            <option value="remote_operator">操作员</option>
            <option value="viewer">查看者</option>
          </select></label>
          {!platformAdmin && <p className="text-xs text-slate-400">管理员角色由平台管理员分配。</p>}
          {role === 'remote_operator' && <p className="text-xs text-slate-400">注册后可在权限管理中分配操作车辆。</p>}
          <button type="submit" className={primaryButtonClass}>生成注册链接</button>
        </fieldset>
      </form>}
      {kind !== 'person' && <form className="space-y-3" onSubmit={event => {
        event.preventDefault()
        const data = new FormData(event.currentTarget)
        void submit({ kind: 'vehicle', vehicle_number: String(data.get('vehicle_number') ?? ''), name: String(data.get('name') ?? '') })
      }}>
        <h2>添加车辆</h2>
        <fieldset disabled={disabled} className="flex flex-col gap-3">
          <label>客户内部车辆编号 <input className={fieldClass} name="vehicle_number" required pattern="[A-Za-z0-9][A-Za-z0-9_.-]{0,23}" maxLength={24} /></label>
          <p className="text-sm text-slate-400">系统自动生成组织短码＋车辆编号＋随机后缀的唯一 ID，后续不随车辆归属变化而修改。</p>
          <label>车辆名称 <input className={fieldClass} name="name" required maxLength={200} /></label>
          <button type="submit" className={primaryButtonClass}>添加车辆</button>
        </fieldset>
      </form>}
    </div>
  </section>
}

export function OnboardingOperations({ operations, busy, onRetry, onTicket, onRegistrationLink }: {
  operations: OnboardingOperation[]; busy: boolean
  onRetry: (id: string) => void; onTicket: (id: string) => void
  onRegistrationLink?: (id: string) => void
}) {
  return <section className="space-y-3">
    <h2>自动接入进度</h2>
    {!operations.length && <p>暂无接入任务。</p>}
    {operations.map(operation => <article key={operation.id} className="space-y-2 break-words rounded border border-slate-700 p-3 text-sm">
      <p>{operation.name} · {operation.kind === 'person' ? '人员' : '车辆'} · {onboardingStatusLabel(registrationLinkAvailable(operation) ? 'awaiting_registration' : operation.status)}</p>
      <details className="text-xs text-slate-400"><summary className="cursor-pointer">诊断详情</summary><p className="mt-2">operation_id: {operation.id} · stage: {operation.stage} · {operation.created_at}</p></details>
      {operation.email && <p>{operation.email}</p>}
      {operation.vehicle_id && <p>车辆 ID: {operation.vehicle_id}</p>}
      {operation.error_code && <p>诊断代码: {operation.error_code}</p>}
      {operation.error_code === 'REGISTRATION_EXPIRED' && <p>链接已过期，请重新添加此用户名以生成新链接。</p>}
      {registrationLinkAvailable(operation) && <button className={primaryButtonClass} disabled={busy} onClick={() => onRegistrationLink?.(operation.id)}><Copy size={14} aria-hidden="true" />复制注册链接</button>}
      {operation.kind === 'person' && operation.status === 'completed' && <p>{operation.email ? '账号设置邀请已处理。' : '用户已在 Casdoor 完成注册。'}</p>}
      {operation.kind === 'vehicle' && operation.status === 'completed' && <p>车辆认证安装已完成；不代表车辆在线、摄像头或视频已就绪，请前往授权车辆监看确认运行状态。</p>}
      {operation.status === 'failed' && <button className={buttonClass} disabled={busy || operation.error_code === 'REGISTRATION_EXPIRED'} onClick={() => onRetry(operation.id)}>重试失败任务</button>}
      {operation.kind === 'vehicle' && operation.status === 'awaiting_install' && (operation.device_enrollment
        ? <p>由车端自动领取凭据；请在车辆终端完成接入，本页面不显示安装令牌或设备密钥。</p>
        : <p>旧的手工安装入口不再支持。请在车辆终端使用 SDK vehicle_bootstrap，并通过机器码重新人工审批；不提供兼容迁移。</p>)}
    </article>)}
  </section>
}

export function InstallationInstructions({ ticket, vehicleId, onClear }: {
  ticket: InstallationTicket; vehicleId: string; onClear: () => void
}) {
  return <section className="space-y-3 rounded border border-amber-600 p-4">
    <h2>单次安装令牌（仅本次显示）</h2>
    <p>到期时间：{ticket.expires_at}。仅复制至受保护的本地文件/终端输入；勿放入 URL、命令参数、历史记录、日志或共享文档。</p>
    <label>短期安装令牌 <textarea className={`${fieldClass} block w-full`} readOnly autoComplete="off" spellCheck={false} value={ticket.token} /></label>
    <button className={buttonClass} onClick={onClear}>清除令牌显示</button>
    <p>此令牌属于旧的手工接入入口，不用于当前 SDK。当前车辆只使用 vehicle_bootstrap --gateway-url HTTPS_URL，并通过机器码和公钥指纹人工审批。不要运行 install-vehicle-auth.py 或把凭据合并到 runtime 配置。</p>
    <p>目标车辆：{vehicleId}。已有设备请保留密钥并使用同一 SDK bootstrap 恢复；旧入口不提供兼容迁移。</p>
  </section>
}

export function CopyText({ value, label }: { value: string; label: string }) {
  const [message, setMessage] = useState('')
  useEffect(() => setMessage(''), [value])
  return <div className="space-y-2">
    <textarea aria-label={label} className={`${fieldClass} font-mono text-xs`} rows={value.includes('\n') ? 13 : 3}
      readOnly autoComplete="off" spellCheck={false} value={value} onFocus={event => event.target.select()} />
    <div className="flex flex-wrap items-center gap-3">
      <button type="button" className={buttonClass} onClick={async () => {
        try { await navigator.clipboard.writeText(value); setMessage('已复制') }
        catch { setMessage('请选中上方内容并手动复制。') }
      }}><Copy size={14} aria-hidden="true" />{label}</button>
      {message && <span role="status" className="text-sm text-slate-300">{message}</span>}
    </div>
  </div>
}

export function VehicleRegistration(props: {
  orgId: string; token: string; disabled: boolean; onDirectoryChange: () => void; onOperationFound?: (id: string) => void
}) {
  return <section className="space-y-5 rounded-xl border border-slate-700 bg-slate-900/60 p-5">
    <h2 className="font-medium text-sky-200">注册车辆</h2>
    <p className="text-sm text-slate-400">先在车端完成配置并运行注册程序，再填写车辆名称和生成的机器码。</p>
    <DeviceEnrollmentPanel {...props} />
  </section>
}

function formatDeviceFingerprint(fingerprint: string): string {
  const match = /^SHA256:([0-9a-fA-F]{16})[0-9a-fA-F]{48}$/.exec(fingerprint)
  if (!match) return fingerprint
  const prefix = match[1].toUpperCase()
  return `${prefix.slice(0, 4)}-${prefix.slice(4, 8)}-${prefix.slice(8, 12)}-${prefix.slice(12, 16)} (${fingerprint})`
}

export function DeviceEnrollmentPanel({ orgId, token, disabled, onDirectoryChange, onOperationFound }: {
  orgId: string; token: string; disabled: boolean; onDirectoryChange: () => void; onOperationFound?: (id: string) => void
}) {
  const [userCode, setUserCode] = useState('')
  const [verifiedFingerprint, setVerifiedFingerprint] = useState('')
  const [result, setResult] = useState<{ orgId: string; token: string; code: string; name: string; record: DeviceEnrollment }>()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [, setClock] = useState(0)
  const request = useRef<AbortController | undefined>(undefined)
  const scope = useRef({ orgId, token, code: userCode, name, disabled })
  scope.current = { orgId, token, code: userCode, name, disabled }
  useEffect(() => {
    request.current?.abort(); request.current = undefined
    setUserCode(''); setResult(undefined); setName(''); setBusy(false); setError(''); setVerifiedFingerprint('')
    return () => { request.current?.abort(); request.current = undefined }
  }, [orgId, token])
  const record = result?.orgId === orgId && result.token === token && result.code === userCode && result.name === name ? result.record : undefined
  const expiresAt = record ? Date.parse(record.expires_at) : NaN
  const pending = record?.status === 'pending' && Number.isFinite(expiresAt) && expiresAt > Date.now()
  useEffect(() => {
    if (!record || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) return
    const timer = setTimeout(() => setClock(value => value + 1), Math.min(expiresAt - Date.now(), 2_147_483_647))
    return () => clearTimeout(timer)
  }, [record, expiresAt])
  const run = async (code: string, operation: (signal: AbortSignal) => Promise<DeviceEnrollment>, refresh = false) => {
    if (disabled || scope.current.disabled || request.current || scope.current.orgId !== orgId
      || scope.current.token !== token || scope.current.code !== code || scope.current.name !== name) return
    const controller = new AbortController()
    request.current = controller
    setBusy(true); setError('')
    const current = () => !controller.signal.aborted && request.current === controller
      && scope.current.orgId === orgId && scope.current.token === token && scope.current.code === code && scope.current.name === name
    try {
      const next = await operation(controller.signal)
      if (!current()) return
      setVerifiedFingerprint('')
      setResult({ orgId, token, code, name, record: next })
      if (next.operation_id) onOperationFound?.(next.operation_id)
      if (refresh) onDirectoryChange()
    } catch (cause) {
      if (current()) setError(adminErrorMessage(cause))
    } finally {
      if (current()) { request.current = undefined; setBusy(false) }
    }
  }
  const changeDetails = (nextName: string, nextCode: string) => {
    request.current?.abort(); request.current = undefined
    scope.current.name = nextName; scope.current.code = nextCode
    setName(nextName); setUserCode(nextCode); setResult(undefined); setError(''); setBusy(false); setVerifiedFingerprint('')
  }
  const status = record && ({
    pending: pending ? '等待审批' : '已过期，不能审批', approved: '已批准，等待设备完成接入',
    provisioning: '已批准，正在配置车辆身份', awaiting_install: '已批准，等待设备完成安装',
    failed: '接入配置失败，请查看接入任务并手动重试',
    denied: '已拒绝', expired: '已过期', active: '注册完成',
  } as Record<string, string>)[record.status]
  return <section className="space-y-3">
    <form onSubmit={event => {
      event.preventDefault()
      const vehicle = deviceEnrollmentApprovalSchema.safeParse({ name })
      if (!vehicle.success) { setError(vehicle.error.issues[0]?.message || '请检查车辆名称。'); return }
      const parsed = enrollmentUserCodeSchema.safeParse(userCode)
      if (!parsed.success) { setError(parsed.error.issues[0]?.message || '请检查机器码。'); return }
      setResult(undefined)
      void run(userCode, signal => lookupDeviceEnrollment(orgId, token, parsed.data, signal))
    }}>
      <fieldset disabled={disabled || busy} className="flex flex-wrap items-end gap-3">
        <label className="min-w-48 max-w-sm flex-1 text-sm">车辆名称 <input className={fieldClass} name="vehicle_name"
          required maxLength={200} value={name} placeholder="CTZY001"
          onChange={event => changeDetails(event.target.value, userCode)} /></label>
        <label className="min-w-48 max-w-xs flex-1 text-sm">机器码 <input className={`${fieldClass} font-mono`} name="user_code"
          autoComplete="off" spellCheck={false} required maxLength={9} value={userCode} placeholder="ABCD-EFGH"
          onChange={event => {
            const code = event.target.value.trim().replace(/-/g, '').toUpperCase()
            changeDetails(name, code)
          }} /></label>
        <button type="submit" className={buttonClass}>核对车辆</button>
      </fieldset>
    </form>
    {busy && <p role="status" className="text-sm">正在处理，请勿重复操作…</p>}
    {error && <AdminNotice error={error} />}
    {record && <div className="space-y-3 text-sm">
      <div className="text-xs text-slate-400">
      <p className="mt-2">请与车端核对机器码和公钥指纹。</p>
      <dl className="mt-2 grid gap-2 break-all sm:grid-cols-2">
        <div><dt className="text-slate-400">公钥 SHA256 指纹</dt><dd className="font-mono">{formatDeviceFingerprint(record.fingerprint)}</dd></div>
        <div><dt className="text-slate-400">申请时间</dt><dd>{record.created_at}</dd></div>
        <div><dt className="text-slate-400">到期时间</dt><dd>{record.expires_at}</dd></div>
      </dl>
      </div>
      <p role="status">{status || '未知状态，不能审批'}</p>
      {record.recovery && <p>恢复已有车辆凭据，保留原车辆和组织绑定。</p>}
      {record.vehicle_id && <p>已绑定车辆 ID：<span className="break-all font-mono">{record.vehicle_id}</span></p>}
      {record.error_code && <p>诊断代码：{record.error_code}</p>}
      {record.operation_id && <div className="space-y-1">
        <p className="break-all">接入任务 ID：{record.operation_id}</p>
        <p className="text-slate-400">在下方“接入与邀请进度”中按此任务 ID 核对状态；失败时使用“重试失败任务”，无需重新批准申请。</p>
      </div>}
      <form onSubmit={event => {
        event.preventDefault()
        if (!pending || verifiedFingerprint !== record.id + ':' + record.fingerprint ||
          Date.parse(record.expires_at) <= Date.now()) return
        void run(userCode, signal => approveDeviceEnrollment(orgId, token, record,
          record.recovery ? undefined : { name }, signal), true)
      }}>
        <fieldset disabled={disabled || busy || !pending} className="flex flex-col gap-3">
          <label className="flex items-start gap-2">
            <input type="checkbox" checked={verifiedFingerprint === record.id + ':' + record.fingerprint}
              onChange={event => setVerifiedFingerprint(event.target.checked ? record.id + ':' + record.fingerprint : '')} />
            我已通过可信渠道核对车端机器码和完整公钥指纹。批准仅授权接入，不代表安装完成或车辆在线。
          </label>
          <div className="flex gap-3">
            <button type="submit" disabled={verifiedFingerprint !== record.id + ':' + record.fingerprint}
              className={primaryButtonClass}>{record.recovery ? '确认恢复车辆' : '确认注册车辆'}</button>
            <button type="button" className={buttonClass} onClick={() => {
              if (!pending || Date.parse(record.expires_at) <= Date.now()) return
              void run(userCode, signal => denyDeviceEnrollment(orgId, token, record.id, signal))
            }}>拒绝申请</button>
          </div>
        </fieldset>
      </form>
    </div>}
  </section>
}

export function OnboardingManager({ orgId, token, platformAdmin, vehicles, disabled, onDirectoryChange, tab, children, enrollmentRevision = 0 }: {
  orgId: string; token: string; platformAdmin: boolean; vehicles: ManagedVehicle[]; disabled: boolean; onDirectoryChange: () => void
  tab?: AdminTab; children?: React.ReactNode; enrollmentRevision?: number
}) {
  const [operations, setOperations] = useState<OnboardingOperation[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0)
  const [ticket, setTicket] = useState<{ value: InstallationTicket; vehicleId: string; operationId: string }>()
  const [registrationLink, setRegistrationLink] = useState<{ value: RegistrationLink; operationId: string }>()
  const previous = useRef(new Map<string, string>())
  const lifetime = useRef<AbortController | undefined>(undefined)
  const inFlight = useRef(false)
  const directoryChange = useRef(onDirectoryChange)
  const currentTab = useRef(tab)
  const progress = useRef<HTMLDetailsElement>(null)
  currentTab.current = tab
  directoryChange.current = onDirectoryChange
  useEffect(() => {
    const controller = new AbortController()
    lifetime.current = controller
    setTicket(undefined); setRegistrationLink(undefined); setOperations([]); setBusy(false); inFlight.current = false; previous.current.clear()
    return () => { controller.abort(); lifetime.current = undefined }
  }, [orgId, token])
  useEffect(() => {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const load = async () => {
      try {
        const next = await fetchOnboardingOperations(orgId, token, controller.signal)
        if (controller.signal.aborted) return
        let changed = false
        for (const operation of next) {
          if (previous.current.get(operation.id) !== operation.status && ['completed', 'awaiting_install'].includes(operation.status)) changed = true
          previous.current.set(operation.id, operation.status)
        }
        setOperations(next)
        if (changed) directoryChange.current()
        if (next.some(onboardingNeedsPolling)) timer = setTimeout(() => void load(), 3000)
      } catch (cause) {
        if (!controller.signal.aborted) setError(adminErrorMessage(cause))
      }
    }
    void load()
    return () => { controller.abort(); if (timer) clearTimeout(timer) }
  }, [orgId, token, revision, enrollmentRevision])
  useEffect(() => {
    if (enrollmentRevision > 0 && progress.current) progress.current.open = true
  }, [enrollmentRevision])
  useEffect(() => {
    if (!ticket) return
    const expiresIn = Date.parse(ticket.value.expires_at) - Date.now()
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) { setTicket(undefined); return }
    const timer = setTimeout(() => setTicket(undefined), Math.min(expiresIn, 2_147_483_647))
    return () => clearTimeout(timer)
  }, [ticket])
  useEffect(() => {
    if (ticket && operations.some(operation => operation.id === ticket.operationId && operation.status === 'completed')) setTicket(undefined)
  }, [ticket, operations])
  useEffect(() => { setTicket(undefined) }, [tab])
  useEffect(() => { setRegistrationLink(undefined) }, [tab])
  useEffect(() => {
    if (!registrationLink) return
    const expiresIn = Date.parse(registrationLink.value.expires_at) - Date.now()
    if (expiresIn <= 0 || operations.some(op => op.id === registrationLink.operationId && !registrationLinkAvailable(op))) {
      setRegistrationLink(undefined); return
    }
    const timer = setTimeout(() => setRegistrationLink(undefined), Math.min(expiresIn, 2_147_483_647))
    return () => clearTimeout(timer)
  }, [registrationLink, operations])
  const run = async (operation: (signal: AbortSignal) => Promise<void>): Promise<boolean> => {
    const controller = lifetime.current
    if (!controller || inFlight.current) return false
    inFlight.current = true
    setBusy(true); setError(''); setNotice('')
    try {
      await operation(controller.signal)
      return !controller.signal.aborted
    } catch (cause) {
      if (!controller.signal.aborted) setError(adminErrorMessage(cause))
      return false
    } finally {
      if (!controller.signal.aborted) { inFlight.current = false; setBusy(false); setRevision(value => value + 1) }
    }
  }
  const remember = (operation: OnboardingOperation) => {
    setOperations(items => [operation, ...items.filter(item => item.id !== operation.id)])
    if (['completed', 'awaiting_install'].includes(operation.status)) directoryChange.current()
  }
  const kind = tab === 'vehicles' ? 'vehicle' : tab === 'people' ? 'person' : undefined
  const visibleOperations = operations.filter(operation => !kind || operation.kind === kind)
  const pendingCount = visibleOperations.filter(operation => operation.status !== 'completed').length
  return <div hidden={tab === 'permissions'} className="space-y-5">
    {error && <AdminNotice error={error} />}
    {notice && <p role="status">{notice}</p>}
    {busy && <p role="status">正在提交接入请求，请勿重复操作…</p>}
    {kind !== 'vehicle' && <details open className="rounded-xl border border-slate-700 bg-slate-900/60 p-5">
      <summary className="flex cursor-pointer items-center gap-2 font-medium text-sky-200"><Plus size={18} aria-hidden="true" />添加人员</summary>
      <div className="mt-5">
    <OnboardingForms platformAdmin={platformAdmin} vehicles={vehicles} disabled={disabled || busy} kind={kind} onSubmit={(input, key) =>
      run(async signal => {
        const operation = await createOnboarding(orgId, token, input, key, signal)
        if (signal.aborted) return
        remember(operation)
        setNotice('正在生成注册链接，请在下方查看。')
        if (progress.current) progress.current.open = true
      })} />
      </div>
    </details>}
    {children}
    <details ref={progress} open={kind === 'person'} className="rounded-xl border border-slate-800 p-5">
      <summary className="cursor-pointer text-sm font-medium">接入与邀请进度 · {visibleOperations.length}
        {pendingCount > 0 && <span className="ml-3 rounded-full bg-amber-500/10 px-2 py-1 text-xs text-amber-200">{pendingCount} 项待处理</span>}
      </summary>
      <div className="mt-4 space-y-4">
    <button className={buttonClass} disabled={busy} onClick={() => { setError(''); setRevision(value => value + 1) }}><RefreshCw size={14} aria-hidden="true" />刷新接入进度</button>
    <OnboardingOperations operations={visibleOperations} busy={busy} onRetry={id => void run(async signal => {
      const operation = await retryOnboarding(orgId, token, id, signal)
      if (!signal.aborted) remember(operation)
    })} onTicket={() => { setTicket(undefined); setError('旧的手工安装入口不再支持，请使用 SDK vehicle_bootstrap。') }}
    onRegistrationLink={id => void run(async signal => {
      setRegistrationLink(undefined)
      const value = await fetchRegistrationLink(orgId, token, id, signal)
      if (signal.aborted || currentTab.current !== tab) return
      setRegistrationLink({ value, operationId: id })
      try { await navigator.clipboard.writeText(value.url); if (!signal.aborted) setNotice('注册链接已复制，可发送给用户。') }
      catch { if (!signal.aborted) setNotice('链接已生成，可在下方手动复制。') }
    })} />
    {registrationLink && <div className="space-y-3 rounded-lg border border-sky-800 p-4">
      <p className="text-sm">发送此链接给用户，在 Casdoor 完成注册。链接仅可使用一次，有效期至 {new Date(registrationLink.value.expires_at).toLocaleString()}。</p>
      <CopyText value={registrationLink.value.url} label="复制注册链接" />
    </div>}
      </div>
    </details>
    {ticket && <InstallationInstructions ticket={ticket.value} vehicleId={ticket.vehicleId} onClear={() => setTicket(undefined)} />}
  </div>
}

export default function Admin() {
  const auth = useAuth()
  const [context, setContext] = useState<AdminContext>()
  const orgId = auth.organizationId
  const setOrgId = auth.selectOrganization
  const [people, setPeople] = useState<ManagedPerson[]>([])
  const [vehicles, setVehicles] = useState<ManagedVehicle[]>([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [revision, setRevision] = useState(0)
  const [contextRevision, setContextRevision] = useState(0)
  const [enrollmentRevision, setEnrollmentRevision] = useState(0)
  const [tab, setTab] = useState<AdminTab>('vehicles')
  const [query, setQuery] = useState('')
  const [editingUserId, setEditingUserId] = useState('')
  useEffect(() => {
    setContext(undefined); setError(''); setNotice('')
    if (!auth.accessToken) { setLoading(false); return }
    const controller = new AbortController()
    setLoading(true)
    void fetchAdminContext(auth.accessToken, controller.signal).then(result => {
      if (controller.signal.aborted) return
      setContext(result)
    }).catch(cause => {
      if (!controller.signal.aborted) setError(adminErrorMessage(cause))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [auth.accessToken, contextRevision])
  useEffect(() => {
    setPeople([]); setVehicles([]); setReady(false)
    if (!orgId || !auth.accessToken) return
    const controller = new AbortController()
    setLoading(true)
    void Promise.all([
      fetchAdminPeople(orgId, auth.accessToken, controller.signal),
      fetchAdminVehicles(orgId, auth.accessToken, controller.signal),
    ]).then(([nextPeople, nextVehicles]) => {
      if (controller.signal.aborted) return
      setPeople(nextPeople); setVehicles(nextVehicles); setReady(true)
    }).catch(cause => {
      if (!controller.signal.aborted) setError(adminErrorMessage(cause))
    }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [orgId, auth.accessToken, revision])
  const mutate = async (operation: () => Promise<void>) => {
    if (saving || loading || !ready) return
    setSaving(true); setError(''); setNotice('')
    try {
      await operation()
      setNotice('后端已确认保存。正在刷新组织列表。')
      setReady(false)
      setRevision(value => value + 1)
    } catch (cause) {
      setError(adminErrorMessage(cause))
      // Even a lost response may have committed; refresh without claiming success.
      setReady(false)
      setRevision(value => value + 1)
    } finally { setSaving(false) }
  }
  const token = auth.accessToken
  const changeTab = (next: AdminTab) => { setTab(next); setQuery('') }
  return <main className="min-h-screen bg-slate-950 text-slate-100">
    <header className="border-b border-slate-800 bg-slate-900/70 px-4 py-5 sm:px-8">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center justify-between gap-4">
      <div className="flex items-center gap-3"><span className="rounded-xl bg-sky-500/10 p-3 text-sky-300"><ShieldCheck size={24} aria-hidden="true" /></span><div>
        <h1 className="text-xl font-semibold">组织管理</h1><p className="mt-1 text-xs text-slate-400">WheelOS · 人员、车辆与访问权限</p>
      </div></div>
      <nav className="flex flex-wrap items-center gap-4 text-sm text-slate-300">
        <Link className="inline-flex items-center gap-1 hover:text-sky-300" to="/"><ArrowLeft size={14} aria-hidden="true" />返回运营平台</Link>
        {token && <button className={buttonClass} disabled={saving} onClick={auth.signOut}><LogOut size={14} aria-hidden="true" />退出登录</button>}
      </nav>
      </div>
    </header>
    <div className="mx-auto max-w-7xl space-y-6 px-4 py-6 sm:px-8">
    {(auth.error || error) && <AdminNotice error={auth.error || error} />}
    {token && error && !context && <button className={buttonClass} disabled={loading} onClick={() => setContextRevision(value => value + 1)}>重新加载管理权限</button>}
    {!token && !auth.loading && <section className="mx-auto max-w-lg rounded-2xl border border-slate-800 bg-slate-900/60 p-8 text-center">
      <ShieldCheck className="mx-auto mb-4 text-sky-300" size={36} aria-hidden="true" /><h2 className="text-lg font-medium">登录组织管理</h2>
      <p className="my-4 text-sm text-slate-400">请先登录；仅平台管理员或获授权组织管理员可访问。普通用户无管理权限。</p>
      <p className="mb-4 text-xs text-slate-500">通过 Casdoor 安全登录，使用组织分配的账号。</p>
      <button className={primaryButtonClass} onClick={() => void auth.signIn()}>管理员登录</button>
    </section>}
    {(auth.loading || loading) && <p role="status">正在加载管理目录…</p>}
    {saving && <p role="status">正在提交，请勿重复操作…</p>}
    {notice && <p role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3 text-sm text-emerald-200">{notice}</p>}
    {token && context && <>
      <div className="flex flex-wrap items-end justify-between gap-4">
      <label className="w-full max-w-sm space-y-2 text-sm text-slate-400"><span>当前组织</span><select className={fieldClass} disabled={saving} value={orgId} onChange={event => {
        setReady(false); setError(''); setNotice(''); setQuery(''); setEditingUserId(''); setOrgId(event.target.value)
      }}>
        {auth.organizations.map(org => <option key={org.org_id} value={org.org_id}>{org.name}</option>)}
      </select></label>
      <span className="rounded-full bg-sky-500/10 px-3 py-1 text-xs text-sky-200">{context.platform_admin ? '平台管理员' : '组织管理员'}</span>
      </div>
      {!context.organizations.length && <p>当前账号没有可管理的组织。</p>}
      {orgId && context.organizations.some(org => org.org_id === orgId) && <>
        <AdminTabs value={tab} onChange={changeTab} peopleCount={people.length} vehicleCount={vehicles.length} />
        <section id={`admin-panel-${tab}`} role="tabpanel" aria-labelledby={`admin-tab-${tab}`} tabIndex={0} className="space-y-6 outline-none">
          {tab === 'people' && <details className="rounded-xl border border-slate-800 p-4 text-sm">
            <summary className="cursor-pointer text-slate-400">添加已有账号</summary>
            <form className="mt-4 space-y-3" onSubmit={event => {
            event.preventDefault()
            const subject = String(new FormData(event.currentTarget).get('subject') ?? '').trim()
            void mutate(() => addExistingMember(orgId, token, subject))
          }}>
            <h2>添加已有账号到当前组织</h2>
            <p className="text-sm text-slate-400">使用已有账号的身份标识，将其加入当前组织。</p>
            <fieldset disabled={loading || saving || !ready} className="flex flex-wrap gap-3">
              <label className="flex-1">已核实的 subject <input className={fieldClass} name="subject" required maxLength={512} autoComplete="off" /></label>
              <button className={buttonClass} type="submit">添加已有成员</button>
            </fieldset>
          </form></details>}
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><h2 className="text-lg font-semibold">{adminTabs.find(item => item.id === tab)?.label}</h2>
              <p className="mt-1 max-w-2xl text-sm text-slate-400">{tab === 'vehicles' ? '填写车辆名称和车端生成的机器码，核对后完成注册。'
                : tab === 'people' ? '填写用户名和角色，发送链接，由用户完成注册。'
                  : '选择人员、设置角色和操作车辆范围。认证由 Casdoor 负责，业务权限由 Gateway 统一执行。'}</p>
            </div>
            <button className={buttonClass} disabled={loading || saving} onClick={() => { setError(''); setRevision(value => value + 1) }}><RefreshCw size={15} aria-hidden="true" />刷新列表</button>
          </div>
          {tab === 'permissions' && <div className="rounded-xl border border-slate-700 bg-slate-900/40 p-4 text-sm text-slate-300">
            请以保存成功后的权限列表为准。若保存时提示需要维护排空，请联系运维处理后手动重试；被拒绝的修改不会自动生效。{context.onboarding_enabled && '新增人员和车辆不需要中断已有会话。'}
          </div>}
          {!context.onboarding_enabled && <p className="rounded-lg border border-amber-500/30 p-4 text-sm text-amber-200">手工预配试点：请先由平台运维在 Casdoor 创建身份，并核实可信 issuer 下的 subject，再创建绑定。本界面不是邀请流程，不生成账号密码、车辆凭据或密钥。保存前需维护排空。</p>}
          {context.onboarding_enabled && tab === 'vehicles' && <VehicleRegistration key={orgId + ':' + token}
            orgId={orgId} token={token} disabled={loading || saving || !ready}
            onOperationFound={() => setEnrollmentRevision(value => value + 1)}
            onDirectoryChange={() => setRevision(value => value + 1)} />}
          {ready && <>
          <label className="relative block max-w-sm"><Search size={16} aria-hidden="true" className="pointer-events-none absolute left-3 top-3 text-slate-500" />
            <input type="search" aria-label={tab === 'vehicles' ? '搜索车辆名称或编号' : '搜索人员名称或角色'} placeholder={tab === 'vehicles' ? '搜索车辆名称或编号…' : '搜索人员名称或角色…'} className={`${fieldClass} pl-9`} value={query} onChange={event => setQuery(event.target.value)} />
          </label>
          {!context.onboarding_enabled && tab !== 'permissions' && <AdminDirectory tab={tab} people={people} vehicles={vehicles} query={query} onEdit={userId => { setEditingUserId(userId); changeTab('permissions') }} />}
          </>}
          {context.onboarding_enabled && <OnboardingManager key={orgId} orgId={orgId} token={token} tab={tab}
            enrollmentRevision={enrollmentRevision}
            platformAdmin={context.platform_admin} vehicles={vehicles} disabled={loading || saving || !ready}
            onDirectoryChange={() => setRevision(value => value + 1)}>
            {ready && tab !== 'permissions' && <AdminDirectory tab={tab} people={people} vehicles={vehicles} query={query} onEdit={userId => { setEditingUserId(userId); changeTab('permissions') }} />}
          </OnboardingManager>}
          {ready && (tab === 'permissions' || !context.onboarding_enabled) && <div className="rounded-xl border border-slate-800 bg-slate-900/40 p-5">
        <AdminForms key={orgId + ':' + revision + ':' + editingUserId + ':' + tab} platformAdmin={context.platform_admin} people={people} vehicles={vehicles}
          section={tab} initialUserId={editingUserId}
          onboardingEnabled={context.onboarding_enabled}
          disabled={loading || saving} onPerson={input => void mutate(() => createAdminPerson(orgId, token, input))}
          onVehicle={input => void mutate(() => createAdminVehicle(orgId, token, input))}
          onAssignment={input => void mutate(() => saveAdminAssignment(orgId, token, input))} />
          </div>}
          {ready && tab === 'permissions' && <AdminDirectory tab={tab} people={people} vehicles={vehicles} query={query} onEdit={userId => setEditingUserId(userId)} />}
          {tab === 'permissions' && <details className="rounded-xl border border-slate-800 p-5 text-sm text-slate-400">
            <summary className="cursor-pointer">角色说明与授权规则</summary>
            <dl className="mt-4 grid gap-4 sm:grid-cols-3">
              <div><dt className="font-medium text-slate-200">查看者</dt><dd className="mt-1">监看本组织全部有效车辆，不具备控制能力。</dd></div>
              <div><dt className="font-medium text-slate-200">操作员</dt><dd className="mt-1">监看并申请授权车辆的控制权；需有效控制租约及车端就绪。</dd></div>
              <div><dt className="font-medium text-slate-200">管理员</dt><dd className="mt-1">管理组织人员与权限，可监看本组织车辆，不获得驾驶或控制能力。</dd></div>
            </dl>
            <p className="mt-4">默认可监看本组织全部有效车辆及新增车辆，无操作权限；操作车辆范围仅限定显式操作授权。禁止修改自身权限。</p>
          </details>}
        </section>
      </>}
    </>}
    </div>
  </main>
}
