import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import * as esbuild from 'esbuild'
import { readFile } from 'node:fs/promises'

const bundle = await esbuild.build({
  stdin: {
    contents: `
      import React from 'react';
      import {renderToStaticMarkup} from 'react-dom/server';
      import {StaticRouter} from 'react-router';
      import OperationsPlatform from './src/pages/OperationsPlatform';
      export * from './src/lib/organization-context';
      export {fetchVehicles} from './src/lib/vehicles-api';
      export {ViewingLifecycle} from './src/lib/viewing-lifecycle';
      export {SimulationController} from './src/lib/simulation-controller';
      export function render(auth, location, vehicles = [], tab = 'realtime', data) {
        globalThis.__PLATFORM_AUTH__ = auth.authorizationContext || !auth.organizationId ? auth : {
          ...auth, authorizationContext: {mode: 'managed', organizations: auth.organizations}
        };
        globalThis.__PLATFORM_VEHICLES__ = vehicles;
        globalThis.__MONITOR_TAB__ = tab;
        globalThis.__MONITOR_DATA__ = data;
        globalThis.__CAMERA_STARTS__ = 0;
        return renderToStaticMarkup(<StaticRouter location={location}><OperationsPlatform /></StaticRouter>);
      }`,
    resolveDir: process.cwd(), loader: 'tsx',
  },
  bundle: true, format: 'cjs', platform: 'node', write: false, jsx: 'automatic',
  plugins: [{
    name: 'platform-auth-boundary',
    setup(build) {
      build.onLoad({ filter: /[/\\]AuthProvider\.tsx$/ }, () => ({
        contents: `export const useAuth = () => globalThis.__PLATFORM_AUTH__;`, loader: 'ts',
      }))
      build.onLoad({ filter: /[/\\]use-vehicles\.ts$/ }, () => ({
        contents: `export const useVehicles = (token, organizationId) => {
          globalThis.__VEHICLE_REQUEST_CONTEXT__ = {token, organizationId};
          return {entries: token ? globalThis.__PLATFORM_VEHICLES__ : [], status: 'ready', requestFailed: false};
        };`, loader: 'ts',
      }))
      build.onLoad({ filter: /[/\\]use-vehicle-data\.ts$/ }, () => ({
        contents: `export const useVehicleData = () => ({data: globalThis.__MONITOR_DATA__, loading: false});`, loader: 'ts',
      }))
      build.onLoad({ filter: /[/\\]use-driving-cameras\.ts$/ }, () => ({
        contents: `export const useDrivingCameras = () => {
          globalThis.__CAMERA_STARTS__++;
          return {tracks: {}, connected: false, error: ''};
        };`, loader: 'ts',
      }))
      build.onLoad({ filter: /[/\\]VehicleMonitor\.tsx$/ }, async ({ path }) => ({
        // Render each selected tab without a browser; keep the actual detail markup and handlers.
        contents: (await readFile(path, 'utf8')).replace("useState('realtime')", "useState(globalThis.__MONITOR_TAB__ ?? 'realtime')"),
        loader: 'tsx',
      }))
    },
  }],
})
const module = { exports: {} }
const originalWindow = globalThis.window
globalThis.window = { location: { hostname: 'localhost', search: '' } }
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(
  createRequire(import.meta.url), module, module.exports,
)
globalThis.window = originalWindow
const api = module.exports
const orgA = '11111111-1111-4111-8111-111111111111'
const orgB = '22222222-2222-4222-8222-222222222222'
const auth = {
  loading: false, organizations: [], organizationId: '', controlBusy: false,
  signIn() {}, signOut() {}, selectOrganization() {}, refreshOrganizations() {},
}

test('every operational root page requires login; authenticated tasks and alerts are honestly unavailable', () => {
  for (const page of ['fleet', 'monitor', 'drive', 'alerts', 'tasks']) {
    const html = api.render(auth, `/?page=${page}`)
    assert.match(html, /登录组织运营平台/)
    assert.doesNotMatch(html, /mock-observer|mock-vehicle|模拟派发/)
  }
  const member = {
    ...auth, accessToken: 'test-only', organizationId: orgA,
    organizations: [{ org_id: orgA, name: 'Member fleet', role: 'viewer', can_manage: false, scope: 'none', vehicle_ids: [] }],
  }
  for (const page of ['alerts', 'tasks']) {
    const html = api.render(member, `/?page=${page}`)
    assert.match(html, page === 'alerts' ? /告警数据暂不可用/ : /任务服务暂不可用/)
    assert.doesNotMatch(html, /派发成功|href="#\/admin"|data-testid="fleet-overview"|车队总览<\/h[12]>|暂无告警|尚未接入真实/)
    if (page === 'tasks') assert.match(html, /<button[^>]*disabled=""[^>]*>创建任务/)
  }
  for (const [page, component] of [['fleet', 'fleet-overview'], ['monitor', 'vehicle-monitor-list'], ['drive', 'remote-driving-list']]) {
    const html = api.render(member, `/?page=${page}`)
    assert.match(html, new RegExp(`data-testid="${component}"`))
    assert.doesNotMatch(html, /Mock 数据|独立授权目录|mock-observer/)
  }
  const html = api.render({ ...member, controlBusy: true }, '/?page=tasks')
  assert.match(html, /disabled=""[^>]*>退出登录/)
  assert.match(html, /请先安全释放/)
})

test('member context is identity-only and vehicle requests explicitly carry the selected organization', async () => {
  const original = globalThis.fetch
  try {
    const requests = []
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init })
      return new Response(JSON.stringify(String(url).endsWith('/context')
        ? { mode: 'managed', organizations: [{ org_id: orgA, name: 'Fleet', role: 'viewer', can_manage: false, scope: 'none', vehicle_ids: [] }] }
        : { vehicles: [] }), { status: 200 })
    }
    api.setRequestOrganization(orgA)
    await api.fetchMemberContext('test-only', new AbortController().signal)
    await api.fetchVehicles('test-only')
    api.setRequestOrganization(orgB)
    await api.fetchVehicles('test-only')
    assert.equal(requests[0].init.headers['X-Organization-ID'], undefined)
    assert.equal(requests[1].init.headers['X-Organization-ID'], orgA)
    assert.equal(requests[2].init.headers['X-Organization-ID'], orgB)
    assert.throws(() => api.memberContextSchema.parse({ organizations: [{
      org_id: orgA, name: 'Fleet', role: 'controller', can_manage: true,
    }] }))
  } finally { globalThis.fetch = original; api.setRequestOrganization('') }
})

test('static context opens the same platform without managed membership and respects server control grants', () => {
  const context = api.memberContextSchema.parse({ mode: 'static', organizations: [], control_vehicle_ids: ['car-one'] })
  const member = { ...auth, accessToken: 'static-only', authorizationContext: context }
  const entries = [{
    vehicle_id: 'car-one', name: 'Static vehicle', state: null, received_at_ms: null,
    server_time_ms: Date.now(), online: false, control: { status: 'free', is_self: false },
  }]
  for (const [page, component] of [['fleet', 'fleet-overview'], ['monitor', 'vehicle-monitor-list'], ['drive', 'remote-driving-list'], ['tasks', 'task-management']]) {
    const html = api.render(member, `/?page=${page}`, entries)
    assert.match(html, new RegExp(`data-testid="${component}"`))
    assert.match(html, /静态授权/)
    assert.doesNotMatch(html, /没有可用组织|尚无可用组织|href="#\/admin"/)
    assert.deepEqual(globalThis.__VEHICLE_REQUEST_CONTEXT__, { token: 'static-only', organizationId: '' })
  }
  assert.equal(api.hasVehicleContext(context, ''), true)
  assert.equal(api.canControlVehicle(context, '', 'car-one'), true)
  assert.equal(api.canControlVehicle(context, '', 'car-other'), false)
  const drive = api.render(member, '/?page=drive&driveVehicle=car-one', entries)
  assert.match(drive, /data-testid="live-driving-workbench"/)
  assert.doesNotMatch(drive, /当前角色无驾驶权限/)
  const observer = api.render({
    ...member, operator: { Roles: ['admin'] },
    authorizationContext: { ...context, control_vehicle_ids: [] },
  }, '/?page=drive&driveVehicle=car-one', entries)
  assert.match(observer, /当前角色无驾驶权限/)
  assert.match(observer, /<button[^>]*disabled=""[^>]*>申请模拟控制权/)
})

test('missing, unknown and failed contexts never become static or invent a managed membership', async () => {
  for (const context of [
    { organizations: [] },
    { mode: 'unknown', organizations: [] },
    { mode: 'static', organizations: [], control_vehicle_ids: [], extra: true },
    { mode: 'static', organizations: [{ org_id: orgA }], control_vehicle_ids: [] },
  ]) assert.throws(() => api.memberContextSchema.parse(context))
  assert.equal(api.hasVehicleContext(undefined, orgA), false)
  assert.equal(api.hasVehicleContext({ mode: 'managed', organizations: [] }, orgA), false)
  const html = api.render({ ...auth, accessToken: 'test-only' }, '/?page=fleet')
  assert.match(html, /没有可用组织或组织上下文尚未加载/)
  assert.doesNotMatch(html, /data-testid="fleet-overview"/)
  const original = globalThis.fetch
  try {
    api.setRequestOrganization('')
    globalThis.fetch = async () => new Response('{}', { status: 404 })
    await assert.rejects(() => api.fetchMemberContext('test-only', new AbortController().signal), /404/)
    globalThis.fetch = async () => new Response(JSON.stringify({ mode: 'unknown', organizations: [] }), { status: 200 })
    await assert.rejects(() => api.fetchMemberContext('test-only', new AbortController().signal))
  } finally { globalThis.fetch = original }
})

test('all members see task vehicles, admins can monitor, and none or out-of-scope operators cannot control', () => {
  const entries = ['car-one', 'car-new'].map(vehicle_id => ({
    vehicle_id, name: vehicle_id, state: null, received_at_ms: null, server_time_ms: Date.now(),
    online: false, control: { status: 'free', is_self: false },
  }))
  const member = (role, scope = 'none', vehicle_ids = []) => ({
    ...auth, accessToken: 'test-only', organizationId: orgA,
    organizations: [{ org_id: orgA, name: 'Fleet', role, scope, vehicle_ids, can_manage: role === 'org_admin' }],
  })
  for (const role of ['viewer', 'remote_operator', 'org_admin']) {
    const html = api.render(member(role), '/?page=tasks', entries)
    assert.match(html, /任务服务暂不可用/)
    assert.match(html, /car-one/)
    assert.match(html, /car-new/)
    assert.doesNotMatch(html, /申请模拟控制权/)
  }
  const monitor = api.render(member('org_admin', 'all'), '/?page=monitor&vehicle=car-one&view=detail', entries)
  assert.match(monitor, /data-testid="vehicle-monitor-detail"/)
  assert.doesNotMatch(monitor, /申请模拟控制权|现有授权不包含实时视频/)
  const viewer = api.render(member('viewer', 'all'), '/?page=drive&driveVehicle=car-one', entries)
  assert.match(viewer, /<button[^>]*disabled=""[^>]*>申请模拟控制权/)
  assert.match(viewer, /当前角色无驾驶权限/)
  for (const [scope, ids] of [['none', []], ['selected', ['car-new']]]) {
    const html = api.render(member('remote_operator', scope, ids), '/?page=drive&driveVehicle=car-one', entries)
    assert.match(html, /无此车辆的驾驶权限/)
    assert.match(html, /<button[^>]*disabled=""[^>]*>申请模拟控制权/)
  }
})

test('authorized monitor restores realtime, health and profile detail without starting video or embedding driving controls', () => {
  const entry = {
    vehicle_id: 'car-one', name: '组织车辆', state: null, received_at_ms: null, server_time_ms: Date.now(),
    receivedAtClientMs: performance.now(), online: false, control: { status: 'free', is_self: false },
  }
  const member = {
    ...auth, accessToken: 'test-only', organizationId: orgA,
    organizations: [{ org_id: orgA, name: 'Fleet', role: 'remote_operator', can_manage: false, scope: 'all', vehicle_ids: [] }],
  }
  const profile = {
    vehicle_id: 'car-one', server_time_ms: Date.now(), events: [], health: null, diagnostics: null,
    profile: { received_at_ms: Date.now(), payload: { model: '真实车型', software_version: 'device-version', map_id: 'org-map' } },
  }
  for (const tab of ['realtime', 'health', 'profile']) {
    const html = api.render(member, '/?page=monitor&vehicle=car-one&view=detail', [entry], tab, profile)
    assert.match(html, /data-testid="vehicle-monitor-detail"/)
    assert.match(html, /实时|健康状态|车辆信息/)
    assert.doesNotMatch(html, /live-driving-workbench|申请模拟控制权|释放控制权|pub-cdn|TeleopWorkbench/)
    assert.equal(globalThis.__CAMERA_STARTS__, 0)
    if (tab === 'realtime') {
      assert.match(html, /开始监看/)
      assert.match(html, /进入远程驾驶/)
      assert.match(html, /BEV \/ 地图/)
      assert.match(html, /速度|挡位|电量|数据更新/)
    } else if (tab === 'health') assert.match(html, /健康检查/)
    else assert.match(html, /真实车型|device-version|org-map/)
  }
  const drive = api.render(member, '/?page=drive&driveVehicle=car-one', [entry])
  assert.match(drive, /data-testid="live-driving-workbench"/)
  assert.doesNotMatch(drive, /data-testid="vehicle-monitor-detail"|车辆详情页签/)
  assert.equal(globalThis.__CAMERA_STARTS__, 1)
  for (const page of ['fleet', 'monitor', 'drive', 'tasks', 'alerts']) {
    const html = api.render(member, `/?page=${page}`, [entry])
    assert.doesNotMatch(html, /真实授权目录和 RTC|组织成员可查看本组织全部有效车辆|当前角色仅可监看|授权平台 · 非 Mock/)
  }
})

test('cancelled viewing acquisition releases in its original organization after a switch', async () => {
  const original = globalThis.fetch
  const session = '33333333-3333-4333-8333-333333333333'
  let respond
  let lifecycle
  try {
    const requests = []
    globalThis.fetch = async (url, init) => {
      requests.push({ url: String(url), init })
      if (String(url).endsWith('/acquire')) return new Promise(resolve => { respond = resolve })
      return new Response(null, { status: 204 })
    }
    api.setRequestOrganization(orgA)
    lifecycle = new api.ViewingLifecycle({
      vehicleId: 'car-one', bearer: 'test-only', clientInstanceId: crypto.randomUUID(),
      createObserver() { throw new Error('Cancelled acquisition must not connect') },
      onConnected() { assert.fail('cancelled viewing connected') },
      onError() { assert.fail('unexpected viewing error') },
      onCleanupError() { assert.fail('viewing cleanup failed') },
    })

    const starting = lifecycle.start()
    await lifecycle.stop()
    api.setRequestOrganization(orgB)
    respond(new Response(JSON.stringify({
      vehicle_id: 'car-one', viewing_session_id: session, expires_at_ms: Date.now() + 30_000,
      server_time_ms: Date.now(), renew_after_ms: 10_000, token: 'test-only',
    }), { status: 200 }))
    await starting
    assert.equal(requests.length, 2)
    assert.ok(requests[1].url.endsWith('/release'))
    assert.equal(requests[0].init.headers['X-Organization-ID'], orgA)
    assert.equal(requests[1].init.headers['X-Organization-ID'], orgA)
  } finally {
    await lifecycle?.stop()
    globalThis.fetch = original
    api.setRequestOrganization('')
  }
})

test('simulation controller retains its original organization throughout its session', async () => {
  const requests = []
  api.setRequestOrganization(orgA)
  const controller = new api.SimulationController('car-one', 'https://gateway.test.invalid', 'test-only',
    { async connect() {}, async publish() {}, async disconnect() {} }, () => {},
    async (url, init) => {
      requests.push({ url: String(url), init })
      return new Response(null, { status: 403 })
    })
  try {
    api.setRequestOrganization(orgB)
    await assert.rejects(controller.acquire(), /HTTP 403/)
    assert.equal(requests[0].init.headers['X-Organization-ID'], orgA)
  } finally {
    await controller.release()
    api.setRequestOrganization('')
  }
})
