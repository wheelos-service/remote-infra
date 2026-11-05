import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { webcrypto } from 'node:crypto'
import * as esbuild from 'esbuild'

// Keep the existing Node/esbuild runner; only the auth boundary is replaced.
const { outputFiles } = await esbuild.build({
  stdin: {
    contents: `
      import React from 'react';
      import {renderToStaticMarkup} from 'react-dom/server';
      import {StaticRouter} from 'react-router';
      import Admin, {AdminForms, AdminNotice, RoleRangeFields, OnboardingForms, OnboardingOperations, InstallationInstructions, OnboardingManager, AdminTabs, AdminDirectory} from './src/pages/Admin';
      import * as api from './src/lib/admin-api';
      export {api, RoleRangeFields, OnboardingForms, OnboardingOperations, OnboardingManager, AdminTabs, AdminDirectory};
      export const renderTabs = props => renderToStaticMarkup(<AdminTabs {...props} />);
      export const renderDirectory = props => renderToStaticMarkup(<AdminDirectory {...props} />);
      export const render = () => renderToStaticMarkup(<StaticRouter location="/admin"><Admin /></StaticRouter>);
      export const renderForms = props => renderToStaticMarkup(<AdminForms {...props} />);
      export const renderError = error => renderToStaticMarkup(<AdminNotice error={api.adminErrorMessage(error)} />);
      export const renderOnboarding = props => renderToStaticMarkup(<OnboardingForms {...props} />);
      export const renderOperations = props => renderToStaticMarkup(<OnboardingOperations {...props} />);
      export const renderInstallation = props => renderToStaticMarkup(<InstallationInstructions {...props} />);
      export const formTree = props => componentTree(AdminForms, props);
      export function componentTree(Component, initialProps) {
        const internals = React.__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED;
        const values = [];
        const effects = [];
        let props = initialProps;
        let index = 0;
        const render = (nextProps = props) => {
          props = nextProps;
          const previous = internals.ReactCurrentDispatcher.current;
          index = 0;
          internals.ReactCurrentDispatcher.current = {
            useState(initial) {
              const current = index++;
              if (!(current in values)) values[current] = initial;
              return [values[current], next => {
                values[current] = typeof next === 'function' ? next(values[current]) : next;
              }];
            },
            useRef(initial) {
              const current = index++;
              return values[current] ??= {current: initial};
            },
            useEffect(effect, deps) {
              const current = index++;
              const previous = effects[current];
              if (!previous || deps.some((value, i) => value !== previous.deps[i])) {
                previous?.cleanup?.();
                effects[current] = {deps, effect, pending: true};
              }
            },
          };
          try { return Component(props); }
          finally { internals.ReactCurrentDispatcher.current = previous; }
        };
        const flushEffects = () => effects.forEach(effect => {
          if (effect.pending) { effect.pending = false; effect.cleanup = effect.effect(); }
        });
        const unmount = () => effects.forEach(effect => effect.cleanup?.());
        return {render, flushEffects, unmount};
      }`,
    resolveDir: process.cwd(), loader: 'tsx',
  },
  bundle: true, format: 'cjs', platform: 'node', write: false,
  plugins: [{
    name: 'admin-auth-test-boundary',
    setup(build) {
      build.onLoad({ filter: /[/\\]AuthProvider\.tsx$/ }, () => ({
        contents: `export const useAuth = () => ({
          loading: false, accessToken: undefined, signIn: async () => {}, signOut: () => {}
        });`, loader: 'ts',
      }))
    },
  }],
})

// Config is browser-injected in production. No test points at a real service.
const previousWindow = globalThis.window
globalThis.window = {
  location: { hostname: 'localhost', search: '' },
  __LIVEKIT_INFRA_CONFIG__: { gatewayUrl: 'https://admin.test.invalid' },
}
const module = { exports: {} }
try {
  new Function('require', 'module', 'exports', outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
} finally {
  globalThis.window = previousWindow
}
const { api, render, renderForms, renderError, formTree, componentTree, RoleRangeFields,
  OnboardingForms, OnboardingOperations, OnboardingManager, renderOnboarding, renderOperations, renderInstallation,
  AdminTabs, AdminDirectory, renderTabs, renderDirectory } = module.exports
globalThis.crypto ??= webcrypto
const person = { user_id: 'user-1', name: 'Person', subject: 'verified-person', status: 'active', role: 'viewer', scope: 'all', vehicle_ids: [] }
const vehicle = { vehicle_id: 'car-1', name: 'Vehicle', status: 'active', subject: 'verified-device' }
const baseProps = { people: [person], vehicles: [vehicle], disabled: false, onPerson() {}, onVehicle() {}, onAssignment() {} }

function elements(node, type) {
  if (!node || typeof node !== 'object') return []
  if (Array.isArray(node)) return node.flatMap(item => elements(item, type))
  if (node.type === RoleRangeFields) return elements(node.type(node.props), type)
  return [...(node.type === type ? [node] : []), ...elements(node.props?.children, type)]
}

test('administrator unauthenticated display makes no requests and exposes no credential forms', async () => {
  const original = globalThis.fetch
  let requests = 0
  globalThis.fetch = async () => { ++requests; throw new Error('must not fetch') }
  try {
    const html = render()
    assert.match(html, /请先登录/)
    assert.match(html, /管理员登录/)
    assert.match(html, /Casdoor/)
    assert.match(html, />返回运营平台<\/a>/)
    assert.equal((html.match(/<a /g) ?? []).length, 1)
    assert.doesNotMatch(html, /page=monitor|\/teleop|preview=1/)
    assert.doesNotMatch(html, /<form|type="password"|Bearer |client_secret|access_token/)
    await assert.rejects(() => api.fetchAdminContext(''), /请先登录/)
    assert.equal(requests, 0)
    const orgHtml = renderForms({ ...baseProps, platformAdmin: false })
    assert.match(orgHtml, /仅能为已有身份分配权限/)
    assert.match(orgHtml, /禁止修改自己的权限/)
    assert.match(orgHtml, /最后一位组织管理员/)
    assert.doesNotMatch(orgHtml, /name="subject"|创建人员绑定|创建车辆绑定/)
  } finally { globalThis.fetch = original }
})

test('admin tabs expose one selected category and support keyboard selection without leaving administration', () => {
  const changes = []
  const props = { value: 'vehicles', peopleCount: 2, vehicleCount: 1, onChange: tab => changes.push(tab) }
  const html = renderTabs(props)
  assert.equal((html.match(/role="tab"/g) ?? []).length, 3)
  assert.equal((html.match(/aria-selected="true"/g) ?? []).length, 1)
  assert.match(html, /车辆管理/)
  assert.match(html, /人员管理/)
  assert.match(html, /权限管理/)
  const harness = componentTree(AdminTabs, props)
  const buttons = elements(harness.render(), 'button')
  buttons[1].props.onClick()
  assert.deepEqual(changes, ['people'])
  const previousDocument = globalThis.document
  let focused
  globalThis.document = { getElementById: id => ({ focus() { focused = id } }) }
  try {
    buttons[0].props.onKeyDown({ key: 'ArrowLeft', preventDefault() {} })
    assert.equal(changes.at(-1), 'permissions')
    assert.equal(focused, 'admin-tab-permissions')
    buttons[2].props.onKeyDown({ key: 'Home', preventDefault() {} })
    assert.equal(changes.at(-1), 'vehicles')
  } finally { globalThis.document = previousDocument }
})

test('admin directories search names and identifiers, show no-access scopes, and link a person to permission editing', () => {
  const edits = []
  const props = { tab: 'people', people: [{ ...person, scope: 'none' }], vehicles: [vehicle], query: '', onEdit: id => edits.push(id) }
  assert.match(renderDirectory(props), /无操作权限/)
  assert.match(renderDirectory(props), /身份详情/)
  assert.doesNotMatch(renderDirectory(props), /车辆登记列表/)
  const harness = componentTree(AdminDirectory, props)
  elements(harness.render(), 'button')[0].props.onClick()
  assert.deepEqual(edits, ['user-1'])
  assert.match(renderDirectory({ ...props, query: 'PERSON' }), /配置权限/)
  assert.match(renderDirectory({ ...props, query: 'missing' }), /没有匹配的记录/)
  assert.match(renderDirectory({ ...props, people: [], query: '' }), /还没有组织人员/)
  const vehicles = renderDirectory({ ...props, tab: 'vehicles', query: 'CAR-1' })
  assert.match(vehicles, /车辆登记列表/)
  assert.match(vehicles, /Vehicle/)
  assert.doesNotMatch(vehicles, /配置权限|人员权限分配/)
})

test('each tab contains only its own creation or permission form and an edit opens existing assignment', () => {
  const props = { platformAdmin: true, vehicles: [vehicle], disabled: false, onSubmit: async () => true }
  const vehicleHtml = renderOnboarding({ ...props, kind: 'vehicle' })
  assert.match(vehicleHtml, /name="vehicle_number"/)
  assert.doesNotMatch(vehicleHtml, /name="email"|固定角色/)
  const personHtml = renderOnboarding({ ...props, kind: 'person' })
  assert.match(personHtml, /name="email"/)
  assert.match(personHtml, /初始权限/)
  assert.doesNotMatch(personHtml, /name="vehicle_number"/)
  for (const section of ['vehicles', 'people']) {
    const manual = renderForms({ ...baseProps, platformAdmin: true, section })
    assert.equal((manual.match(/<form/g) ?? []).length, 1)
    assert.doesNotMatch(manual, /人员权限分配/)
    assert.match(manual, section === 'vehicles' ? /name="vehicle_id"/ : /创建人员绑定/)
  }
  const submissions = []
  const harness = formTree({ ...baseProps, people: [{ ...person, role: 'remote_operator', scope: 'selected', vehicle_ids: ['car-1'] }],
    platformAdmin: true, onboardingEnabled: true, section: 'permissions', initialUserId: 'user-1',
    onAssignment: input => submissions.push(input) })
  const forms = elements(harness.render(), 'form')
  assert.equal(forms.length, 1)
  forms[0].props.onSubmit({ preventDefault() {} })
  assert.deepEqual(submissions, [{ user_id: 'user-1', role: 'remote_operator', scope: 'selected', vehicle_ids: ['car-1'] }])
})

test('administrator forms submit verified bindings and fixed-role assignment payloads', async () => {
  const originalFetch = globalThis.fetch
  const originalFormData = globalThis.FormData
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) })
    return new Response('{}', { status: 201 })
  }
  globalThis.FormData = class {
    constructor(form) { this.values = form }
    get(key) { return this.values[key] ?? null }
  }
  try {
    const submissions = []
    const harness = formTree({
      ...baseProps, platformAdmin: true,
      onPerson: body => submissions.push(api.createAdminPerson('org /1', 'test-bearer', body)),
      onVehicle: body => submissions.push(api.createAdminVehicle('org /1', 'test-bearer', body)),
      onAssignment: body => submissions.push(api.saveAdminAssignment('org /1', 'test-bearer', body)),
    })
    let tree = harness.render()
    const submit = (form, values) => form.props.onSubmit({ preventDefault() {}, currentTarget: values })
    const forms = elements(tree, 'form')
    submit(forms[0], { name: ' Person ', subject: ' verified-person ' })
    submit(forms[1], { vehicle_id: ' car-1 ', name: ' Vehicle ', subject: ' verified-device ' })
    let selects = elements(tree, 'select')
    selects[0].props.onChange({ target: { value: 'user-1' } })
    tree = harness.render()
    selects = elements(tree, 'select')
    selects[1].props.onChange({ target: { value: 'remote_operator' } })
    selects[2].props.onChange({ target: { value: 'selected' } })
    tree = harness.render()
    elements(tree, 'input').find(input => input.props.type === 'checkbox').props.onChange({ target: { checked: true } })
    tree = harness.render()
    submit(elements(tree, 'form')[2], {})
    await Promise.all(submissions)
    assert.deepEqual(requests.map(request => request.body), [
      { name: 'Person', subject: 'verified-person' },
      { vehicle_id: 'car-1', name: 'Vehicle', subject: 'verified-device' },
      { user_id: 'user-1', role: 'remote_operator', scope: 'selected', vehicle_ids: ['car-1'] },
    ])
    assert.ok(requests.every(({ url, options }) => url.startsWith('https://admin.test.invalid/api/admin/organizations/org%20%2F1/')
      && options.method === 'POST' && options.headers.Authorization === 'Bearer test-bearer' && options.cache === 'no-store'))
    assert.ok(requests[2].url.endsWith('/assignments'))
    await api.saveAdminAssignment('org', 'test-bearer', { user_id: 'user-1', role: 'viewer', scope: 'all', vehicle_ids: ['car-1'] })
    assert.deepEqual(requests[3].body.vehicle_ids, [])
    for (const invalid of [
      { role: 'superuser', scope: 'all', vehicle_ids: [] },
      { role: 'viewer', scope: 'selected', vehicle_ids: [] },
      { role: 'org_admin', scope: 'selected', vehicle_ids: ['car-1'] },
    ]) {
      await assert.rejects(() => api.saveAdminAssignment('org', 'test-bearer', { user_id: 'user-1', ...invalid }))
    }
    assert.equal(requests.length, 4)
  } finally { globalThis.fetch = originalFetch; globalThis.FormData = originalFormData }
})

test('administrator errors preserve correlation, deny unauthorized access and explain active-session drain', async () => {
  const original = globalThis.fetch
  try {
    for (const response of [
      new Response(JSON.stringify({ error: 'Forbidden', code: 'FORBIDDEN', request_id: 'req-forbidden' }), { status: 403 }),
      new Response('upstream unavailable', { status: 503, headers: { 'X-Request-ID': 'req-text' } }),
      new Response(JSON.stringify({ error: 'session active', code: 'MANAGED_DRAIN_REQUIRED', request_id: 'req-drain' }), { status: 409 }),
      new Response('expired', { status: 401, headers: { 'X-Request-ID': 'req-expired' } }),
    ]) {
      globalThis.fetch = async () => response
      await assert.rejects(() => api.fetchAdminContext('test-bearer'), error => {
        const html = renderError(error)
        assert.match(html, /role="alert"/)
        assert.match(html, /request_id: req-/)
        if (error.status === 403) assert.match(html, /没有此组织的管理权限/)
        if (error.status === 401) assert.match(html, /重新登录/)
        if (error.status === 409) {
          assert.match(html, /未保存/)
          assert.match(html, /TTL/)
          assert.match(html, /不会自动生效/)
          assert.match(html, /MANAGED_DRAIN_REQUIRED/)
        }
        return true
      })
    }
  } finally { globalThis.fetch = original }
})

test('administrator loads context and empty lists and rejects malformed or legacy responses', async () => {
  const original = globalThis.fetch
  try {
    const context = { mode: 'managed', organizations: [{ org_id: 'org', name: 'Org' }], platform_admin: false, manual_provisioning: true, onboarding_enabled: false }
    const bodies = [context, [], []]
    globalThis.fetch = async () => new Response(JSON.stringify(bodies.shift()))
    assert.deepEqual(await api.fetchAdminContext('test-bearer'), context)
    assert.deepEqual(await api.fetchAdminPeople('org', 'test-bearer'), [])
    assert.deepEqual(await api.fetchAdminVehicles('org', 'test-bearer'), [])
    for (const raw of ['not json', JSON.stringify({ ...context, mode: 'legacy' }), '{}']) {
      globalThis.fetch = async () => new Response(raw)
      await assert.rejects(() => api.fetchAdminContext('test-bearer'), /无效 JSON|格式不符/)
    }
    globalThis.fetch = async () => { throw new Error('network failed') }
    await assert.rejects(() => api.createAdminPerson('org', 'test-bearer', { name: 'Name', subject: 'verified' }), /结果未知/)
  } finally { globalThis.fetch = original }
})

test('administrator timed-out assignment stays uncertain without automatic mutation retry', async context => {
  const original = globalThis.fetch
  let requests = 0
  let signal
  context.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.fetch = async (_url, options) => {
    requests++
    signal = options.signal
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  }
  try {
    const rejection = assert.rejects(() => api.saveAdminAssignment('org', 'test-bearer', {
      user_id: 'user-1', role: 'viewer', scope: 'all', vehicle_ids: [],
    }), /结果未知/)
    context.mock.timers.tick(8000)
    await rejection
    assert.equal(signal.aborted, true)
    assert.equal(requests, 1)
  } finally { globalThis.fetch = original; context.mock.timers.reset() }
})

const operation = {
  id: 'op-1', kind: 'person', name: 'New Person', email: 'person@example.test',
  status: 'pending', stage: 'invitation', error_code: '', created_at: '2026-11-04T10:00:00Z',
}
const personInput = { kind: 'person', name: ' New Person ', email: ' person@example.test ', role: 'viewer', scope: 'all', vehicle_ids: ['car-1'] }
const submissionKey = '3bba1dd7-e77f-4871-9f31-cfbe96a815c7'

test('automated onboarding APIs validate inputs, encode routes, preserve idempotency, and strip unrecognized response fields', async () => {
  const original = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options, body: options.body && JSON.parse(options.body) })
    const body = url.endsWith('/installation-ticket') ? { token: 'ephemeral-enrollment-only', expires_at: '2030-01-01T00:00:00Z' }
      : options.method === 'GET' && url.endsWith('/onboarding') ? [operation]
        : { ...operation, client_secret: 'must-not-survive-response-parsing' }
    return new Response(JSON.stringify(body))
  }
  try {
    assert.deepEqual(await api.createOnboarding('org /1', 'admin-bearer', personInput, submissionKey), operation)
    assert.deepEqual(requests[0].body, {
      ...personInput, name: 'New Person', email: 'person@example.test', vehicle_ids: [], idempotency_key: submissionKey,
    })
    assert.deepEqual(await api.fetchOnboardingOperations('org /1', 'admin-bearer'), [operation])
    assert.deepEqual(await api.fetchOnboardingOperation('org /1', 'admin-bearer', 'op /1'), operation)
    assert.deepEqual(await api.retryOnboarding('org /1', 'admin-bearer', 'op /1'), operation)
    assert.equal((await api.createInstallationTicket('org /1', 'admin-bearer', 'op /1')).token, 'ephemeral-enrollment-only')
    assert.ok(requests.every(({ url, options }) => url.startsWith('https://admin.test.invalid/api/admin/organizations/org%20%2F1/onboarding')
      && !url.includes('ephemeral-enrollment-only') && options.headers.Authorization === 'Bearer admin-bearer' && options.cache === 'no-store'))
    assert.match(requests[2].url, /\/op%20%2F1$/)
    assert.match(requests[3].url, /\/op%20%2F1\/retry$/)
    assert.equal(requests[3].options.method, 'POST')
    assert.deepEqual(requests[4].body, {})
    for (const invalid of [
      { ...personInput, name: '  ' }, { ...personInput, email: 'invalid' },
      { ...personInput, role: 'superuser' }, { ...personInput, scope: 'selected', vehicle_ids: [] },
      { ...personInput, role: 'org_admin', scope: 'selected' },
      { kind: 'vehicle', vehicle_id: 'bad/id', name: 'Vehicle' },
    ]) await assert.rejects(() => api.createOnboarding('org', 'admin-bearer', invalid, submissionKey))
    assert.equal(requests.length, 5)
    assert.equal(api.onboardingNeedsPolling({ ...operation, status: 'future-pending-state' }), true)
    assert.equal(api.onboardingNeedsPolling({ ...operation, status: 'completed' }), false)
    assert.equal(api.onboardingNeedsPolling({ ...operation, status: 'failed' }), false)
    assert.match(api.onboardingStatusLabel('future-pending-state'), /未知状态.*尚未完成/)
    globalThis.fetch = async () => new Response(JSON.stringify({
      mode: 'managed', organizations: [], platform_admin: true, manual_provisioning: false, onboarding_enabled: true,
    }))
    assert.equal((await api.fetchAdminContext('admin-bearer')).onboarding_enabled, true)
    globalThis.fetch = async () => new Response(JSON.stringify({ error: 'mail unavailable', code: 'MAIL_PENDING', request_id: 'req-onboarding' }), { status: 503 })
    await assert.rejects(() => api.createOnboarding('org', 'admin-bearer', personInput, submissionKey), error => {
      assert.match(renderError(error), /MAIL_PENDING.*request_id: req-onboarding/)
      return true
    })
  } finally { globalThis.fetch = original }
})

test('automated forms default to no vehicle authority and reuse a key after an uncertain submission', async () => {
  const originalFormData = globalThis.FormData
  globalThis.FormData = class {
    constructor(form) { this.values = form }
    get(key) { return this.values[key] ?? null }
  }
  const props = { platformAdmin: true, vehicles: [vehicle], disabled: false, onSubmit: async () => true }
  try {
    const manual = renderForms({ ...baseProps, platformAdmin: true, onboardingEnabled: true })
    assert.doesNotMatch(manual, /name="subject"|创建人员绑定|创建车辆绑定/)
    assert.match(manual, /保存权限分配/)
    const html = renderOnboarding(props)
    assert.match(html, /添加人员/)
    assert.match(html, /type="email"/)
    assert.match(html, /添加车辆/)
    assert.match(html, /none · 无操作权限（默认）/)
    assert.match(html, /操作车辆范围/)
    assert.match(html, /包括新增车辆/)
    assert.doesNotMatch(html, /subject|client_secret|type="password"/)
    const emptyFleet = renderOnboarding({ ...props, vehicles: [] })
    assert.match(emptyFleet, /none · 无操作权限（默认）/)
    assert.doesNotMatch(emptyFleet, /<button[^>]*\sdisabled(?:=""|\s|>)[^>]*>添加人员并发送邀请/)
    assert.doesNotMatch(renderOnboarding({ ...props, platformAdmin: false }), /value="org_admin"/)
    const submissions = []
    let succeeds = false
    const harness = componentTree(OnboardingForms, { ...props, onSubmit: async (body, key) => {
      submissions.push({ body, key }); return succeeds
    } })
    let tree = harness.render()
    const submit = (form, values) => form.props.onSubmit({ preventDefault() {}, currentTarget: values })
    submit(elements(tree, 'form')[0], { name: 'Person', email: 'bad-email' })
    assert.equal(submissions.length, 0)
    submit(elements(tree, 'form')[0], { name: ' Person ', email: ' person@example.test ' })
    await Promise.resolve()
    submit(elements(tree, 'form')[0], { name: ' Person ', email: ' person@example.test ' })
    await Promise.resolve()
    assert.equal(submissions.length, 2)
    assert.match(submissions[0].key, /^[0-9a-f-]{36}$/)
    assert.equal(submissions[0].key, submissions[1].key)
    assert.deepEqual(submissions[0].body, { kind: 'person', name: 'Person', email: 'person@example.test', role: 'viewer', scope: 'none', vehicle_ids: [] })
    tree = harness.render({ ...props, kind: 'vehicle', onSubmit: async (body, key) => { submissions.push({ body, key }); return false } })
    submit(elements(tree, 'form')[0], { vehicle_number: 'truck-002', name: 'Vehicle' })
    await Promise.resolve()
    tree = harness.render({ ...props, kind: 'person', onSubmit: async (body, key) => { submissions.push({ body, key }); return false } })
    submit(elements(tree, 'form')[0], { name: 'Person', email: 'person@example.test' })
    await Promise.resolve()
    assert.equal(submissions.at(-1).key, submissions[0].key, 'switching tabs must preserve uncertain person submission identity')
    tree = harness.render({ ...props, onSubmit: async (body, key) => { submissions.push({ body, key }); return succeeds } })
    succeeds = true
    submit(elements(tree, 'form')[0], { name: 'Person', email: 'person@example.test' })
    await Promise.resolve()
    submit(elements(tree, 'form')[1], { vehicle_number: ' TRUCK-002 ', name: ' Vehicle ' })
    await Promise.resolve()
    assert.deepEqual(submissions.at(-1).body, { kind: 'vehicle', vehicle_number: 'truck-002', name: 'Vehicle' })
    assert.notEqual(submissions.at(-1).key, submissions[0].key)
  } finally { globalThis.FormData = originalFormData }
})

test('operation rendering distinguishes pending delivery and installation, and retries only failed operations', () => {
  const operations = [
    operation, { ...operation, id: 'done', status: 'completed', stage: 'invitation_sent' },
    { ...operation, id: 'failed', status: 'failed', error_code: 'MAIL_UNAVAILABLE' },
    { ...operation, id: 'install', kind: 'vehicle', status: 'awaiting_install', vehicle_id: 'car-1' },
    { ...operation, id: 'installed', kind: 'vehicle', status: 'completed', stage: 'installation_completed', vehicle_id: 'car-2' },
    { ...operation, id: 'unknown', status: 'new-state' },
  ]
  const html = renderOperations({ operations, busy: false, onRetry() {}, onTicket() {} })
  assert.match(html, /邮件邀请尚未确认完成/)
  assert.match(html, /等待车辆安装（尚未接入）/)
  assert.match(html, /账号与权限已配置；请通过 Casdoor 邮件完成账号设置/)
  assert.match(html, /不代表已完成首次登录/)
  assert.match(html, /车辆认证安装已完成；不代表车辆在线、摄像头或视频已就绪/)
  assert.match(html, /operation_id:.*stage:/)
  assert.match(html, /MAIL_UNAVAILABLE/)
  assert.match(html, /未知状态，尚未完成/)
  assert.equal((html.match(/重试失败任务/g) ?? []).length, 1)
  assert.equal((html.match(/签发单次安装令牌/g) ?? []).length, 1)
})

const settle = () => new Promise(resolve => setImmediate(resolve))

test('switching tabs filters onboarding operations and discards an installation ticket still being issued', async () => {
  const originalFetch = globalThis.fetch
  const installOperation = { ...operation, kind: 'vehicle', vehicle_id: 'car-1', status: 'awaiting_install' }
  let issueTicket
  globalThis.fetch = async url => url.endsWith('/installation-ticket')
    ? new Promise(resolve => { issueTicket = resolve })
    : new Response(JSON.stringify([operation, { ...installOperation, id: 'vehicle-op' }]))
  const props = { orgId: 'org', token: 'admin-bearer', platformAdmin: true, vehicles: [vehicle], disabled: false, tab: 'vehicles', onDirectoryChange() {} }
  const harness = componentTree(OnboardingManager, props)
  try {
    harness.render(); harness.flushEffects(); await settle()
    let tree = harness.render()
    assert.equal(elements(tree, OnboardingForms)[0].props.kind, 'vehicle')
    const panel = elements(tree, OnboardingOperations)[0]
    assert.deepEqual(panel.props.operations.map(item => item.kind), ['vehicle'])
    panel.props.onTicket('vehicle-op')
    tree = harness.render({ ...props, tab: 'people' }); harness.flushEffects()
    issueTicket(new Response(JSON.stringify({ token: 'must-not-display', expires_at: new Date(Date.now() + 60_000).toISOString() })))
    await settle()
    tree = harness.render({ ...props, tab: 'people' })
    assert.equal(elements(tree, OnboardingForms)[0].props.kind, 'person')
    assert.deepEqual(elements(tree, OnboardingOperations)[0].props.operations.map(item => item.kind), ['person'])
    assert.equal(elements(tree, 'textarea').length, 0)
    const hasTicket = node => {
      if (!node || typeof node !== 'object') return false
      if (Array.isArray(node)) return node.some(hasTicket)
      return !!node.props?.ticket || hasTicket(node.props?.children)
    }
    assert.equal(hasTicket(tree), false)
    assert.equal(harness.render({ ...props, tab: 'permissions' }).props.hidden, true)
  } finally { harness.unmount(); globalThis.fetch = originalFetch }
})

test('pending operation polling refreshes directory transitions, stops when completed, and aborts on cleanup', async context => {
  const original = globalThis.fetch
  const responses = [
    [operation],
    [{ ...operation, kind: 'vehicle', vehicle_id: 'car-1', status: 'awaiting_install' }],
    [{ ...operation, kind: 'vehicle', vehicle_id: 'car-1', status: 'completed' }],
  ]
  const requests = []
  let directoryRefreshes = 0
  context.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.fetch = async (_url, options) => {
    requests.push(options.signal)
    return new Response(JSON.stringify(responses.shift() ?? []))
  }
  const props = { orgId: 'org', token: 'admin-bearer', platformAdmin: true, vehicles: [vehicle], disabled: false,
    onDirectoryChange: () => { directoryRefreshes++ } }
  const harness = componentTree(OnboardingManager, props)
  try {
    harness.render(); harness.flushEffects(); await settle()
    assert.equal(requests.length, 1)
    context.mock.timers.tick(2999); await settle()
    assert.equal(requests.length, 1)
    context.mock.timers.tick(1); await settle()
    assert.equal(directoryRefreshes, 1)
    context.mock.timers.tick(3000); await settle()
    assert.equal(directoryRefreshes, 2)
    context.mock.timers.tick(60_000); await settle()
    assert.equal(requests.length, 3)
    harness.unmount()
    let pendingSignal
    globalThis.fetch = async (_url, options) => {
      pendingSignal = options.signal
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }))
    }
    const pending = componentTree(OnboardingManager, props)
    pending.render(); pending.flushEffects()
    assert.equal(pendingSignal.aborted, false)
    pending.unmount(); await settle()
    assert.equal(pendingSignal.aborted, true)
    context.mock.timers.tick(60_000); await settle()
  } finally { harness.unmount(); globalThis.fetch = original; context.mock.timers.reset() }
})

test('installation tickets are explicit, transient, expire, and never reach persistent storage or URLs', async context => {
  const originalFetch = globalThis.fetch
  const originalStorage = globalThis.localStorage
  const originalSessionStorage = globalThis.sessionStorage
  const token = 'single-use-test-enrollment'
  const ticket = { token, expires_at: new Date(Date.now() + 60_000).toISOString() }
  const installOperation = { ...operation, kind: 'vehicle', vehicle_id: 'car-1', status: 'awaiting_install' }
  const requests = []
  context.mock.timers.enable({ apis: ['setTimeout'] })
  globalThis.localStorage = globalThis.sessionStorage = {
    setItem() { assert.fail('installation tickets must never be persisted') },
    getItem() { assert.fail('installation tickets must never be recovered from storage') },
  }
  globalThis.fetch = async (url, options) => {
    requests.push({ url, body: options.body })
    return new Response(JSON.stringify(url.endsWith('/installation-ticket') ? ticket : [installOperation]))
  }
  const props = { orgId: 'org', token: 'admin-bearer', platformAdmin: true, vehicles: [vehicle], disabled: false, onDirectoryChange() {} }
  const harness = componentTree(OnboardingManager, props)
  try {
    harness.render(); harness.flushEffects(); await settle()
    assert.equal(requests.filter(request => request.url.endsWith('/installation-ticket')).length, 0)
    let tree = harness.render()
    const panel = elements(tree, OnboardingOperations)[0]
    panel.props.onTicket('op-1'); await settle()
    tree = harness.render(); harness.flushEffects()
    const instructions = node => {
      if (!node || typeof node !== 'object') return undefined
      if (Array.isArray(node)) return node.map(instructions).find(Boolean)
      if (node.props?.ticket) return node
      return instructions(node.props?.children)
    }
    assert.equal(instructions(tree).props.ticket.token, token)
    const html = renderInstallation(instructions(tree).props)
    assert.match(html, /autocomplete="off"/i)
    assert.match(html, /readOnly=""/i)
    assert.match(html, /--gateway.*--vehicle-id/)
    assert.doesNotMatch(html, /client_secret|href=|<script/)
    assert.ok(!html.slice(html.indexOf('<pre'), html.indexOf('</pre>')).includes(token))
    assert.ok(requests.every(request => !request.url.includes(token) && !String(request.body).includes(token)))
    instructions(tree).props.onClear()
    assert.equal(instructions(harness.render()), undefined)
    panel.props.onTicket('op-1'); await settle()
    tree = harness.render(); harness.flushEffects()
    context.mock.timers.tick(60_000); await settle()
    assert.equal(instructions(harness.render()), undefined)
    assert.equal(requests.filter(request => request.url.endsWith('/installation-ticket')).length, 2)
    panel.props.onTicket('op-1'); await settle()
    harness.render({ ...props, orgId: 'other-org' }); harness.flushEffects()
    assert.equal(instructions(harness.render({ ...props, orgId: 'other-org' })), undefined)
  } finally {
    harness.unmount(); globalThis.fetch = originalFetch
    globalThis.localStorage = originalStorage; globalThis.sessionStorage = originalSessionStorage
    context.mock.timers.reset()
  }
})
