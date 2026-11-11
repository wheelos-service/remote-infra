import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as esbuild from 'esbuild'
import { webcrypto } from 'node:crypto'
import { createRequire } from 'node:module'
import { convertMap, parseMapText } from './prepare-maps.mjs'
globalThis.crypto ??= webcrypto

globalThis.window = {
  location: { hostname: 'localhost', search: '' },
  __LIVEKIT_INFRA_CONFIG__: undefined,
}

const { outputFiles } = await esbuild.build({
  entryPoints: [
    { in: 'src/lib/vehicles-api.ts', out: 'vehicles-api' },
    { in: 'src/lib/vehicle-telemetry.ts', out: 'vehicle-telemetry' },
    { in: 'src/lib/viewing-api.ts', out: 'viewing-api' },
    { in: 'src/lib/viewing-lifecycle.ts', out: 'viewing-lifecycle' },
    { in: 'src/lib/vehicle-operations-api.ts', out: 'vehicle-operations-api' },
    { in: 'src/lib/vehicle-data-api.ts', out: 'vehicle-data-api' },
    { in: 'src/lib/preview-vehicles.ts', out: 'preview-vehicles' },
    { in: 'src/lib/control-protocol.ts', out: 'control-protocol' },
    { in: 'src/lib/control-session-client.ts', out: 'control-session-client' },
    { in: 'src/lib/control-input-adapter.ts', out: 'control-input-adapter' },
    { in: 'src/lib/camera-view.ts', out: 'camera-view' },
    { in: 'src/lib/camera-feed.ts', out: 'camera-feed' },
    { in: 'src/lib/fleet-map.ts', out: 'fleet-map' },
    { in: 'src/lib/mock-fleet.ts', out: 'mock-fleet' },
    { in: 'src/lib/teleop-config.ts', out: 'teleop-config' },
    { in: 'src/lib/dashboard-data.ts', out: 'dashboard-data' },
    { in: 'src/lib/fleet-overview.ts', out: 'fleet-overview' },
    { in: 'src/lib/vehicle-alerts.ts', out: 'vehicle-alerts' },
    { in: 'src/lib/vehicle-monitor.ts', out: 'vehicle-monitor' },
    { in: 'src/lib/operations-navigation.ts', out: 'operations-navigation' },
  ],
  outdir: 'test-build',
  bundle: true,
  format: 'esm',
  platform: 'node',
  write: false,
})

async function loadBundle(name) {
  const file = outputFiles.find(({ path }) => path.endsWith(`${name}.js`))
  assert.ok(file, `missing ${name} test bundle`)
  return import(`data:text/javascript;base64,${Buffer.from(file.contents).toString('base64')}`)
}

const api = await loadBundle('vehicles-api')
const telemetry = await loadBundle('vehicle-telemetry')
const viewing = await loadBundle('viewing-api')
const { ViewingLifecycle } = await loadBundle('viewing-lifecycle')
const operations = await loadBundle('vehicle-operations-api')
const dataAPI = await loadBundle('vehicle-data-api')
const preview = await loadBundle('preview-vehicles')
const controlProtocol = await loadBundle('control-protocol')
const { ControlSessionClient } = await loadBundle('control-session-client')
const controlInput = await loadBundle('control-input-adapter')
const cameraView = await loadBundle('camera-view')
const cameraFeed = await loadBundle('camera-feed')
const fleetMap = await loadBundle('fleet-map')
const mockFleet = await loadBundle('mock-fleet')
const dashboard = await loadBundle('dashboard-data')
const fleetOverview = await loadBundle('fleet-overview')
const vehicleAlerts = await loadBundle('vehicle-alerts')
const vehicleMonitor = await loadBundle('vehicle-monitor')
const navigation = await loadBundle('operations-navigation')

const authBundle = await esbuild.build({
  entryPoints: ['src/app/AuthProvider.tsx'],
  bundle: true, format: 'cjs', platform: 'node', write: false,
})
const authModule = { exports: {} }
new Function('require', 'module', 'exports', authBundle.outputFiles[0].text)(
  createRequire(import.meta.url), authModule, authModule.exports,
)
const { authCallbackRoute, restoreAuthenticatedRoute } = authModule.exports

test('callback restoration notifies HashRouter after replacing browser history', () => {
  const previousWindow = globalThis.window
  const previousDocument = globalThis.document
  const previousEvent = globalThis.PopStateEvent
  try {
    const calls = []
    globalThis.PopStateEvent = class { constructor(type) { this.type = type } }
    globalThis.document = { title: 'Platform' }
    globalThis.window = {
      location: { origin: 'https://platform.test.invalid', pathname: '/' },
      history: { replaceState: (...args) => calls.push(args) },
      dispatchEvent: event => calls.push(event.type),
    }
    restoreAuthenticatedRoute('/?page=drive')
    assert.deepEqual(calls, [[{}, 'Platform', 'https://platform.test.invalid/#/?page=drive'], 'popstate'])
  } finally {
    globalThis.window = previousWindow
    globalThis.document = previousDocument
    globalThis.PopStateEvent = previousEvent
  }
})

test('root OAuth callbacks safely restore unified platform routes', () => {
  assert.equal(authCallbackRoute('?code=one-time&state=state', '/admin'), '/admin')
  assert.equal(authCallbackRoute('?code=one-time&state=state', '/teleop'), '/')
  assert.equal(authCallbackRoute('?error=access_denied', '/teleop'), '/')
  assert.equal(authCallbackRoute('?code=one-time&state=state', '/?page=monitor&vehicle=car-one'), '/?page=monitor&vehicle=car-one')
  for (const route of [null, '/', '//outside.invalid', 'https://outside.invalid']) {
    assert.equal(authCallbackRoute('?code=one-time&state=state', route), '/')
  }
  assert.equal(authCallbackRoute('?preview=1', '/admin'), undefined)
  assert.equal(authCallbackRoute('', '/teleop'), undefined)
})

test('operations navigation round-trips vehicle/filter context and rejects invalid routes', () => {
  const state = { ...navigation.defaultNavigation, page: 'alerts', vehicle: 'sim-004',
    alertSection: 'work', query: '告警 & event=1', state: 'all', selectedVehicle: 'sim-004',
    monitorQuery: '车 & 004', driveVehicle: 'sim-007', fromAlerts: 'yes' }
  const search = navigation.navigationSearch(state)
  assert.deepEqual(navigation.readNavigation(search).data, state)
  assert.equal(navigation.readNavigation('page=unknown').success, false)
  assert.equal(navigation.readNavigation('page=drive&driveFilter=alerts').success, false)
  assert.equal(navigation.readNavigation('severity=INVALID').success, false)
  assert.equal(navigation.navigationSearch(navigation.defaultNavigation), '')
  assert.equal(navigation.readNavigation('page=drive&driveVehicle=missing').data.driveVehicle, 'missing')
})

const mapText = `header { version: "fixture-v1" }
lane {
  id { id: "lane-1" }
  central_curve { segment { line_segment { point { x: 100 y: 200 } point { x: 110 y: 200 } point { x: 110 y: 220 } } } }
  left_boundary { curve { segment { line_segment { point { x: 100 y: 202 } point { x: 112 y: 220 } } } } }
  right_boundary { curve { segment { line_segment { point { x: 100 y: 198 } point { x: 108 y: 220 } } } } }
}`
const demoMap = fleetMap.fleetMapSchema.parse(convertMap(mapText, 'fixture-map'))

test('local simulation and preview flags without endpoint overrides preserve default URLs', async () => {
  const search = window.location.search
  try {
    window.location.search = '?preview=1&fleet=1&dev=1&control=simulation'
    const { teleopConfig } = await loadBundle('teleop-config')
    assert.ok(teleopConfig.gatewayUrl.startsWith('https://'))
    assert.ok(teleopConfig.livekitUrl.startsWith('wss://'))
    assert.equal(teleopConfig.simulationControl, true)
  } finally { window.location.search = search }
})

test('Apollo map conversion keeps absolute sampled geometry, frame and separate lane boundaries', () => {
  assert.equal(parseMapText('header { version: "\\351\\235\\222" }').header[0].version[0], '青')
  assert.deepEqual(demoMap.bounds, [100, 198, 112, 220])
  assert.equal(demoMap.frame_id, 'map:fixture-map')
  assert.deepEqual(demoMap.lanes[0].center, [[100, 200], [110, 200], [110, 220]])
  assert.equal(demoMap.lanes[0].left.length, 2)
  assert.throws(() => convertMap('header { version: "empty" }', 'empty'))
  assert.throws(() => convertMap(mapText, '../escape'))
  assert.throws(() => parseMapText('lane { id { id: "unclosed" }'))
  assert.throws(() => parseMapText('lane { } }'))
  assert.throws(() => convertMap(mapText.replace('x: 100', 'x: NaN'), 'invalid'))
  assert.throws(() => fleetMap.fleetMapSchema.parse({ ...demoMap, frame_id: 'guessed-utm' }))
  assert.throws(() => fleetMap.fleetMapSchema.parse({ ...demoMap, bounds: [0, 0, 1, 1] }))
})

test('lane sampling follows arc length and rejects zero-length routes and invalid distances', () => {
  assert.deepEqual(fleetMap.lanePosition(demoMap.lanes[0].center, 15), { x: 110, y: 205, heading: Math.PI / 2 })
  assert.deepEqual(fleetMap.lanePosition(demoMap.lanes[0].center, 35), { x: 105, y: 200, heading: 0 })
  for (const distance of [NaN, Infinity, -1]) assert.throws(() => fleetMap.lanePosition(demoMap.lanes[0].center, distance))
  assert.throws(() => fleetMap.lanePosition([[1, 1], [1, 1]], 0))
})

test('dynamic fleet uses actual map coordinates with independent fresh, stale, offline and restarted streams', () => {
  const started = 1_793_333_000_000
  const before = mockFleet.createMockFleet(demoMap, 0, started, 0)
  const after = mockFleet.createMockFleet(demoMap, 31_000, started, 31_000)
  assert.equal(after.entries.length, 8)
  assert.equal(new Set(after.entries.map((entry) => entry.vehicle_id)).size, 8)
  for (const entry of after.entries) {
    const { receivedAtClientMs, receivedAtWallMs, ...wire } = entry
    api.vehicleEntrySchema.parse(wire)
    assert.equal(entry.state.localization.message.frame_id, demoMap.frame_id)
    const { x, y } = entry.state.localization.message.position
    assert.ok(x >= demoMap.bounds[0] && x <= demoMap.bounds[2])
    assert.ok(y >= demoMap.bounds[1] && y <= demoMap.bounds[3])
  }
  assert.notDeepEqual(before.entries[0].state.localization.message.position, after.entries[0].state.localization.message.position)
  assert.deepEqual(before.entries[1].state.localization.message.position, after.entries[1].state.localization.message.position)
  assert.deepEqual(before.entries[4].state.localization.message.position, after.entries[4].state.localization.message.position)
  assert.equal(telemetry.getSampleFreshness(after.entries[4].state.localization, after.entries[4], 31_000).state, 'stale')
  assert.equal(telemetry.getSampleFreshness(after.entries[4].state.chassis, after.entries[4], 31_000).state, 'fresh')
  assert.equal(telemetry.directoryOnline(after.entries[6], false, 31_000), false)
  assert.deepEqual(before.entries[6].state, after.entries[6].state)
  assert.notEqual(before.entries[7].state.stream_id, after.entries[7].state.stream_id)
  assert.equal(after.entries[7].state.sequence, 3)
  assert.equal(telemetry.getSampleFreshness(after.entries[0].state.chassis, after.entries[0], 37_000).state, 'stale')
  assert.equal(telemetry.directoryOnline(after.entries[0], false, 42_000), false)
  assert.notEqual(mockFleet.createMockFleet(demoMap, 0, started + 1, 0).entries[0].state.stream_id, before.entries[0].state.stream_id)
})

test('mock Monitor recovery and unknown tasks pass actual data contracts without management authority', () => {
  const started = 1_793_333_000_000
  const failure = mockFleet.createMockVehicleData('sim-006', demoMap, 10_000, started)
  const recovery = mockFleet.createMockVehicleData('sim-006', demoMap, 20_000, started)
  assert.equal(failure.health.payload.sample.message.hmi_modules.monitor.status, 'ERROR')
  assert.deepEqual(recovery.events.map((event) => event.transition), ['raised', 'recovered'])
  assert.equal(recovery.events[0].event_id, failure.events[0].event_id)
  assert.equal(recovery.health.payload.sample.message.hmi_modules.monitor.status, 'OK')
  const unknown = mockFleet.createMockVehicleData('sim-008', demoMap, 31_000, started)
  assert.equal(unknown.tasks[0].result.status, 'unknown')
  assert.equal(unknown.can_manage, false)
  assert.equal(unknown.profile.payload.map_id, demoMap.id)
  assert.equal(dataAPI.healthFreshness(unknown, 0).fresh, true)
  assert.equal(dataAPI.healthFreshness(mockFleet.createMockVehicleData('sim-007', demoMap, 31_000, started), 0).fresh, false)
  dataAPI.vehicleDataSchema.parse(unknown)
  assert.throws(() => mockFleet.createMockVehicleData('real-car', demoMap, 0, started))
})

test('backup dashboard adapter distinguishes parked, faulty, stale and offline vehicles without invented metrics', () => {
  const started = 1_793_333_000_000
  const fleet = mockFleet.createMockFleet(demoMap, 1000, started, 1000)
  const summaries = fleet.entries.map((entry) => dashboard.dashboardVehicle(entry,
    mockFleet.createMockVehicleData(entry.vehicle_id, demoMap, 1000, started), demoMap, 1000))
  assert.equal(summaries[0].speedKmh, 7.2)
  assert.equal(summaries[1].status, 'IDLE')
  assert.equal(summaries[1].gear, 'P')
  assert.equal(summaries[2].gear, 'R')
  assert.equal(summaries[3].batteryPercent, 12)
  assert.equal(summaries[3].status, 'ALARM')
  assert.match(summaries[4].localizationLabel, /过期/)
  assert.equal(summaries[6].status, 'OFFLINE')
  assert.equal(summaries[6].speedKmh, null)
  assert.equal(summaries[6].batteryPercent, undefined)
  assert.equal(summaries[6].gear, '—')
  assert.match(summaries[0].locationLabel, /fixture-v1/)
  assert.deepEqual(dashboard.mapPercent(demoMap, 100, 198), { left: '5%', top: '95%' })
  const brokenFrame = structuredClone(fleet.entries[0])
  brokenFrame.state.localization.message.frame_id = 'different-map'
  assert.equal(dashboard.dashboardVehicle(brokenFrame, undefined, demoMap, 1000).position, undefined)
  const stopped = dashboard.dashboardVehicle(fleet.entries[0], undefined, demoMap, 13_000)
  assert.equal(stopped.status, 'OFFLINE')
  assert.equal(stopped.speedKmh, null)
})

test('backup alert/task adapters preserve recovery and unknown outcomes and handle empty snapshots', () => {
  const started = 1_793_333_000_000
  const failure = { 'sim-006': mockFleet.createMockVehicleData('sim-006', demoMap, 1000, started) }
  const recovery = { 'sim-006': mockFleet.createMockVehicleData('sim-006', demoMap, 21_000, started) }
  assert.equal(dashboard.dashboardAlerts(failure)[0].status, 'open')
  assert.equal(dashboard.dashboardAlerts(recovery)[0].status, 'closed')
  assert.equal(dashboard.dashboardAlerts(recovery)[0].id, dashboard.dashboardAlerts(failure)[0].id)
  const task = dashboard.dashboardTasks({ 'sim-008': mockFleet.createMockVehicleData('sim-008', demoMap, 1000, started) })[0]
  assert.equal(task.status, 'unknown')
  assert.equal(task.vehicleId, 'sim-008')
  assert.match(dashboard.dashboardDetails(recovery['sim-006']).diagnosis, /OK/)
  assert.match(dashboard.dashboardDetails(undefined).diagnosis, /不能推断健康/)
  assert.deepEqual(dashboard.dashboardAlerts({}), [])
  assert.deepEqual(dashboard.dashboardTasks({}), [])
})

test('overview counts driving mode independently of motion, health and remote control occupancy', () => {
  const start = 1_793_333_000_000
  const fleet = mockFleet.createMockFleet(demoMap, 1000, start, 1000)
  const data = Object.fromEntries(fleet.entries.map((entry) => [entry.vehicle_id,
    mockFleet.createMockVehicleData(entry.vehicle_id, demoMap, 1000, start)]))
  const rows = fleet.entries.map((entry) => fleetOverview.overviewVehicle(entry, data[entry.vehicle_id], demoMap, 1000))
  assert.equal(rows[1].mode, 'auto', 'stopped auto remains autonomous mode')
  assert.equal(rows[3].mode, 'auto', 'fault does not rewrite driving mode')
  assert.equal(rows[3].health, 'fault')
  assert.equal(rows[4].health, 'unknown', 'stale source is not an authoritative fault')
  assert.equal(rows[6].mode, 'unknown')
  assert.equal(rows[6].speed, null)
  assert.deepEqual(fleetOverview.fleetMetrics(rows, data), { total: 8, online: 7, auto: 7, manual: 0, unknown: 1, faults: 3, attention: 4 })
  const manual = structuredClone(fleet.entries[0])
  manual.state.chassis.message.driving_mode = 'COMPLETE_MANUAL'
  manual.control = { status: 'free', is_self: false }
  const row = fleetOverview.overviewVehicle(manual, data[manual.vehicle_id], demoMap, 1000)
  assert.equal(row.mode, 'manual')
  assert.equal(row.control, '无远程会话')
  manual.state.chassis.message.driving_mode = 'AUTO_STEER_ONLY'
  manual.control = { status: 'occupied', is_self: true }
  assert.equal(fleetOverview.overviewVehicle(manual, data[manual.vehicle_id], demoMap, 1000).mode, 'partial')
  manual.state.chassis.source_timestamp_ms = start - 10_000
  assert.equal(fleetOverview.overviewVehicle(manual, data[manual.vehicle_id], demoMap, 1000).mode, 'unknown')
  assert.equal(fleetOverview.overviewVehicle(manual, data[manual.vehicle_id], demoMap, 1000).online, true)
})

test('overview evaluates all Monitor checks, unknowns, map mismatch and retained fault recovery separately', () => {
  const start = 1_793_333_000_000
  const entry = mockFleet.createMockFleet(demoMap, 1000, start, 1000).entries[0]
  const data = mockFleet.createMockVehicleData(entry.vehicle_id, demoMap, 1000, start)
  data.health.payload.sample.message.require_emergency_stop = false
  data.health.payload.sample.message.hmi_modules.monitor.status = 'ERROR'
  assert.equal(fleetOverview.overviewVehicle(entry, data, demoMap, 1000).health, 'fault')
  data.health.payload.sample.message.hmi_modules.monitor.status = 'WARN'
  assert.equal(fleetOverview.overviewVehicle(entry, data, demoMap, 1000).health, 'degraded')
  data.health.payload.sample.message.hmi_modules.monitor.status = 'OK'
  data.health.payload.sample.message.components_truncated = true
  assert.equal(fleetOverview.overviewVehicle(entry, data, demoMap, 1000).health, 'unknown')
  data.health.payload.sample.message.components_truncated = false
  assert.equal(fleetOverview.overviewVehicle(entry, data, demoMap, 1000).health, 'ok')
  entry.state.localization.message.frame_id = 'wrong-map'
  assert.equal(fleetOverview.overviewVehicle(entry, data, demoMap, 1000).position, undefined)
  assert.equal(fleetOverview.overviewVehicle(entry, data, demoMap, 1000).health, 'unknown')
  entry.state.localization.message.frame_id = demoMap.frame_id
  entry.state.localization.message.position.x = demoMap.bounds[2] + 1
  assert.equal(fleetOverview.overviewVehicle(entry, data, demoMap, 1000).health, 'unknown')
  const recovered = mockFleet.createMockVehicleData('sim-006', demoMap, 21_000, start)
  assert.equal(fleetOverview.activeFaults(recovered), 0)
  assert.equal(fleetOverview.activeFaults(mockFleet.createMockVehicleData('sim-006', demoMap, 1000, start)), 1)
  assert.equal(fleetOverview.activeFaults(undefined), 0)
  const fault = mockFleet.createMockVehicleData('sim-004', demoMap, 1000, start)
  fault.events.push({ ...fault.events[0], event_id: 'changed', transition: 'changed', severity: 'FATAL', occurred_at_ms: start + 500 })
  assert.equal(fleetOverview.activeFaults(fault), 2)
})

test('vehicle alerts group fault occurrences, preserve recovery evidence and do not treat acknowledgement as recovery', () => {
  const start = 1_793_333_000_000
  const data = mockFleet.createMockVehicleData('sim-006', demoMap, 21_000, start)
  const raised = data.events[0], recovery = data.events[1]
  data.events = [recovery, { ...raised, event_id: 'changed', transition: 'changed', occurred_at_ms: start + 1000 }, raised, raised]
  let items = vehicleAlerts.vehicleAlerts(data)
  assert.equal(items.length, 1)
  assert.equal(items[0].events.length, 3, 'deduplicate exact event IDs')
  assert.equal(items[0].state, 'recovered')
  assert.equal(items[0].startedAt, start)
  assert.equal(items[0].recoveredAt, start + 20_000)
  data.events.push({ ...raised, event_id: 'raised-again', occurred_at_ms: start + 30_000 })
  items = vehicleAlerts.vehicleAlerts(data)
  assert.equal(items.length, 2, 'recurrence creates a new occurrence')
  assert.equal(items[0].state, 'active')
  assert.notEqual(items[0].id, items[1].id)
  data.acknowledgements = [{ event_id: 'raised-again', operator_id: 'observer', acknowledged_at_ms: start + 31_000 }]
  assert.equal(vehicleAlerts.pendingAlertCount(data), 1)
  assert.equal(fleetOverview.activeFaults(data), 1, 'overview and event center share the same model')
  data.events = [{ ...raised, event_id: 'orphan-change', transition: 'changed' }]
  assert.equal(vehicleAlerts.vehicleAlerts(data)[0].historyIncomplete, true)
  assert.equal(vehicleAlerts.pendingAlertCount(data), 1)
  data.events = [recovery]
  assert.equal(vehicleAlerts.vehicleAlerts(data)[0].severity, 'UNKNOWN', 'no invented historical severity')
  assert.equal(vehicleAlerts.pendingAlertCount(data), 0)
  data.events = [raised, { ...recovery, occurred_at_ms: start }]
  assert.equal(vehicleAlerts.vehicleAlerts(data)[0].state, 'unknown', 'conflicting equal timestamps have no authoritative ordering')
  assert.equal(vehicleAlerts.pendingAlertCount(data), 1, 'ambiguous recovery does not erase pending fault')
  data.events[0].vehicle_id = 'wrong-car'
  assert.throws(() => vehicleAlerts.vehicleAlerts(data), /身份不一致/)
})

test('vehicle alert grouping shows multiple faults per car and keeps totals independent of filters', () => {
  const start = 1_793_333_000_000
  const records = Object.fromEntries(['sim-004', 'sim-006'].map((id) =>
    [id, mockFleet.createMockVehicleData(id, demoMap, 6000, start)]))
  const groups = vehicleAlerts.groupVehicleAlerts(records, { 'sim-004': '港区巡检车' })
  assert.equal(groups.length, 2)
  assert.equal(groups[0].pending, 2)
  assert.equal(groups[0].alerts.length, 2, 'changed event does not inflate fault count')
  assert.equal(groups[0].alerts[0].severity, 'ERROR', 'show severe vehicle faults ahead of warnings')
  assert.equal(groups[0].alerts.find((item) => item.faultKey === 'hmi_modules/monitor').events.length, 2)
  const filters = { ...vehicleAlerts.initialAlertFilters, query: '港区' }
  assert.deepEqual(vehicleAlerts.filterVehicleAlerts(groups, filters, start + 6000).map((group) => group.vehicleId), ['sim-004'])
  filters.query = 'MOCK-3-CHANGED'
  const matches = vehicleAlerts.filterVehicleAlerts(groups, filters, start + 6000)
  assert.equal(matches.length, 1)
  assert.equal(matches[0].alerts.length, 1)
  assert.equal(matches[0].pending, 2, 'vehicle-wide count remains visible under event search')
  filters.vehicle = 'sim-006'
  assert.deepEqual(vehicleAlerts.filterVehicleAlerts(groups, filters, start + 6000), [])
  assert.equal(groups.reduce((sum, group) => sum + group.pending, 0), 3)
  assert.equal(vehicleAlerts.filterVehicleAlerts(groups, { ...vehicleAlerts.initialAlertFilters, severity: 'critical' }, start + 6000)
    .reduce((sum, group) => sum + group.alerts.length, 0), 2)
})

test('alert filters use event timestamps for 24h changes and allow searching recovered event history', () => {
  const start = 1_793_333_000_000
  const data = mockFleet.createMockVehicleData('sim-006', demoMap, 21_000, start)
  const groups = vehicleAlerts.groupVehicleAlerts({ [data.vehicle_id]: data })
  const filters = { ...vehicleAlerts.initialAlertFilters, query: 'mock-5-recovered' }
  assert.deepEqual(vehicleAlerts.filterVehicleAlerts(groups, filters, start + 21_000), [])
  filters.state = 'all'
  assert.equal(vehicleAlerts.filterVehicleAlerts(groups, filters, start + 21_000)[0].alerts[0].state, 'recovered')
  filters.period = '24h'
  assert.equal(vehicleAlerts.filterVehicleAlerts(groups, filters, start + 86_400_000 + 20_000).length, 1, 'inclusive boundary')
  assert.equal(vehicleAlerts.filterVehicleAlerts(groups, filters, start + 86_400_000 + 20_001).length, 0)
  assert.equal(vehicleAlerts.filterVehicleAlerts(groups, filters, start - 1).length, 0, 'future events are not in the past 24h')
  filters.period = 'retained'
  filters.severity = 'WARN'
  assert.equal(vehicleAlerts.filterVehicleAlerts(groups, filters, start + 21_000).length, 0)
  assert.equal(vehicleAlerts.pendingAlertCount(undefined), 0)
})

test('dashboard period summary counts occurrences by actual raised/recovered timestamps, not changed records or vehicle closures', () => {
  const start = 1_793_333_000_000
  const fault = mockFleet.createMockVehicleData('sim-004', demoMap, 6000, start)
  const recovered = mockFleet.createMockVehicleData('sim-006', demoMap, 21_000, start)
  const groups = vehicleAlerts.groupVehicleAlerts({ [fault.vehicle_id]: fault, [recovered.vehicle_id]: recovered })
  assert.deepEqual(vehicleAlerts.alertPeriodSummary(groups, start, start + 21_000), { vehicles: 2, added: 3, recovered: 1 })
  assert.deepEqual(vehicleAlerts.alertPeriodSummary(groups, start + 1, start + 21_000), { vehicles: 0, added: 0, recovered: 1 },
    'changed event does not become an added alarm; recovery belongs to its own time')
  assert.deepEqual(vehicleAlerts.alertPeriodSummary(groups, start + 20_000, start + 20_000), { vehicles: 0, added: 0, recovered: 1 })
  recovered.events = [recovered.events[1]]
  assert.deepEqual(vehicleAlerts.alertPeriodSummary(vehicleAlerts.groupVehicleAlerts({ recovered }), start, start + 21_000),
    { vehicles: 0, added: 0, recovered: 1 }, 'missing start does not invent a raised alarm')
  for (const [from, to] of [[NaN, start], [start, Infinity], [start + 1, start]]) {
    assert.throws(() => vehicleAlerts.alertPeriodSummary(groups, from, to), /时间范围/)
  }
})

test('full vehicle timeline combines all fault keys and acknowledgements at their own times without cross-vehicle records', () => {
  const start = 1_793_333_000_000
  const data = mockFleet.createMockVehicleData('sim-004', demoMap, 6000, start)
  const ack = { event_id: 'mock-3-battery-raised', operator_id: 'test-operator', acknowledged_at_ms: start + 2000 }
  data.acknowledgements = [ack, ack, { ...ack, event_id: 'not-loaded' }]
  const items = vehicleAlerts.vehicleTimeline(data)
  assert.equal(items.length, 4)
  assert.equal(new Set(items.map((item) => item.event.fault_key)).size, 2, 'timeline spans the whole vehicle, not one selected alarm')
  assert.equal(items[2].kind, 'human')
  assert.equal(items[2].at, start + 2000)
  assert.equal(items[2].operator, 'test-operator')
  assert.equal(items[3].event.transition, 'changed')
  assert.ok(items.every((item) => item.event.vehicle_id === data.vehicle_id))
  assert.deepEqual(vehicleAlerts.vehicleTimeline(undefined), [])
  const recovered = mockFleet.createMockVehicleData('sim-006', demoMap, 21_000, start)
  assert.equal(vehicleAlerts.vehicleTimeline(recovered).at(-1).event.transition, 'recovered')
})

test('developer map preserves metric aspect ratio and prioritizes selected labels without moving anchors', () => {
  const view = fleetOverview.fitMap([100, 200, 300, 240], 800, 400)
  const origin = fleetOverview.screenPoint({ x: 100, y: 200 }, view, 800, 400)
  const east = fleetOverview.screenPoint({ x: 110, y: 200 }, view, 800, 400)
  const north = fleetOverview.screenPoint({ x: 100, y: 210 }, view, 800, 400)
  assert.ok(Math.abs((east.x - origin.x) - (origin.y - north.y)) < 1e-8)
  assert.throws(() => fleetOverview.fitMap([0, 0, 1, 1], 0, 400))
  const start = 1_793_333_000_000
  const fleet = mockFleet.createMockFleet(demoMap, 1000, start, 1000)
  const rows = fleet.entries.map((entry) => ({ ...fleetOverview.overviewVehicle(entry, undefined, demoMap, 1000), position: { x: 200, y: 220, heading: 0 } }))
  const labels = fleetOverview.markerLabels(rows, view, 800, 400, 'sim-008')
  assert.equal(labels[0].row.id, 'sim-008')
  assert.ok(labels[0].label)
  assert.deepEqual(labels[0].position, labels[1].position)
  assert.equal(fleetOverview.markerLabels([{ ...rows[0], position: { x: 1e9, y: 1e9 } }], view, 800, 400, 'sim-001')[0].label, undefined)
  const shown = labels.filter((value) => value.label)
  for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) {
    assert.ok(Math.abs(shown[i].label.x - shown[j].label.x) >= 112 || Math.abs(shown[i].label.y - shown[j].label.y) >= 27)
  }
})

test('local BEV projects metric positions heading-up without aspect distortion and freezes old locations', () => {
  const pose = { x: 100, y: 200, heading: 0 }
  assert.deepEqual(vehicleMonitor.bevPoint({ x: 100, y: 200 }, pose, 800, 400, 40), { x: 400, y: 200 })
  assert.deepEqual(vehicleMonitor.bevPoint({ x: 110, y: 200 }, pose, 800, 400, 40), { x: 400, y: 100 }, 'east-facing vehicle sees east ahead')
  assert.deepEqual(vehicleMonitor.bevPoint({ x: 100, y: 210 }, pose, 800, 400, 40), { x: 300, y: 200 }, 'north is left of east-facing car')
  const north = vehicleMonitor.bevPoint({ x: 100, y: 210 }, { ...pose, heading: Math.PI / 2 }, 800, 400, 40)
  assert.ok(Math.abs(north.x - 400) < 1e-8 && Math.abs(north.y - 100) < 1e-8)
  const reverse = vehicleMonitor.bevPoint({ x: 110, y: 200 }, { ...pose, heading: Math.PI }, 800, 400, 40)
  assert.ok(Math.abs(reverse.y - 300) < 1e-8, 'projection follows body heading, not travel direction')
  for (const range of [0, -1, NaN, Infinity]) assert.throws(() => vehicleMonitor.bevPoint(pose, pose, 800, 400, range))
  const start = 1_793_333_000_000
  const entry = mockFleet.createMockFleet(demoMap, 1000, start, 1000).entries[0]
  const row = fleetOverview.overviewVehicle(entry, undefined, demoMap, 1000)
  const fresh = vehicleMonitor.bevPose(row)
  assert.ok(fresh)
  const stale = { ...row, localizationFresh: false, position: { x: 200, y: 220, heading: 1 } }
  assert.deepEqual(vehicleMonitor.bevPose(stale, fresh), fresh, 'stale updates never move the camera')
  assert.deepEqual(vehicleMonitor.bevPose({ ...stale, online: false }, fresh), fresh)
  assert.deepEqual(vehicleMonitor.bevPose(stale), stale.position, 'initial old snapshot can be shown explicitly as old')
  assert.equal(vehicleMonitor.bevPose({ ...stale, position: undefined }, fresh), undefined, 'invalid frame/bounds cannot reuse stale geometry')
  assert.equal(vehicleMonitor.bevPose({ ...row, position: { x: 100, y: 200 } }, fresh), undefined, 'missing heading is not guessed')
})

test('passive vehicle diagnosis prioritizes faults and treats missing, stale and partial data as unknown', () => {
  const start = 1_793_333_000_000
  const entry = mockFleet.createMockFleet(demoMap, 6000, start, 6000).entries[3]
  const data = mockFleet.createMockVehicleData(entry.vehicle_id, demoMap, 6000, start)
  let checks = vehicleMonitor.vehicleHealthChecks(entry, data, 6000)
  assert.equal(checks[0].status, 'FATAL')
  assert.equal(checks.find((check) => check.key === 'chassis').status, 'ERROR')
  assert.equal(checks.find((check) => check.key === '其他检查/battery').status, 'WARN')
  checks = vehicleMonitor.vehicleHealthChecks(entry, data, 20_000)
  assert.ok(checks.every((check) => check.status === 'UNKNOWN'), 'stale values cannot remain healthy or current faults')
  delete entry.state.chassis.message.error_code
  delete entry.state.chassis.message.chassis_error_mask
  assert.equal(vehicleMonitor.vehicleHealthChecks(entry, undefined, 6000).find((check) => check.key === 'chassis').status, 'UNKNOWN')
  entry.state.chassis.message.driving_mode = 'EMERGENCY_MODE'
  assert.equal(vehicleMonitor.vehicleHealthChecks(entry, undefined, 6000).find((check) => check.key === 'chassis').status, 'ERROR')
  data.health.payload.sample.message.components_truncated = true
  assert.ok(vehicleMonitor.vehicleHealthChecks(entry, data, 6000).filter((check) =>
    check.key.startsWith('模块/') || check.key.startsWith('其他检查/')).every((check) => check.status === 'UNKNOWN'))
})

test('shared input converts normalized intent to v2 integers without enabling legacy actions', () => {
  const convert = controlInput.toV2ControlCommand
  assert.deepEqual(convert({ mode: 'low_level', steering: -0.5, throttle: 0.125, brake: 0, direction: -1 }),
    { steering: -500, throttle: 125, brake: 0, direction: -1 })
  for (const action of ['stop', 'emergency_stop']) assert.deepEqual(convert({ mode: 'high_level', action }),
    { steering: 0, throttle: 0, brake: 1000, direction: 0 })
  assert.equal(convert({ mode: 'high_level', action: 'reverse' }).direction, -1)
  assert.equal(convert({ mode: 'high_level', action: 'left' }).throttle, 0)
  for (const action of ['gear_drive', 'auto_enter', 'auto_exit']) {
    assert.throws(() => convert({ mode: 'high_level', action }))
  }
  for (const value of [NaN, Infinity, 1.01]) {
    assert.throws(() => convert({ mode: 'low_level', steering: value, throttle: 0, brake: 0, direction: 0 }))
  }
  assert.throws(() => convert({ mode: 'low_level', steering: 0, throttle: 0.5, brake: 0.5, direction: 1 }))
  assert.throws(() => convert({ mode: 'low_level', steering: 0, throttle: 0.0001, brake: 0.0001, direction: 1 }))
  assert.equal(controlInput.v2GamepadMapping.autoEnterButton, -1)
  assert.equal(controlInput.v2GamepadMapping.reverseButton, -1)
})

test('v2 input capability gate stops held movement instead of passing gear or mode through', async () => {
  const sent = [], states = []
  const input = new controlInput.ControlInput({
    allowVehicleActions: false, send: async (intent) => { sent.push(controlInput.toV2ControlCommand(intent)) },
    onChange: (value) => states.push(value), onError: (error) => { throw error },
  })
  try {
    input.setAvailable(true)
    input.setKeyboardEnabled(true)
    await flush()
    input.keyDown('KeyW')
    await flush()
    input.keyDown('KeyE')
    await flush()
    assert.deepEqual(sent.at(-1), { steering: 0, throttle: 0, brake: 1000, direction: 0 })
    assert.equal(input.isKeyboardEnabled, false)
    assert.match(states.at(-1).message, /未开放/)
    const count = sent.length
    input.keyDown('KeyW', true)
    assert.equal(sent.length, count)
  } finally { input.setAvailable(false) }
})

test('shared gamepad uses the v2 adapter and release replaces propulsion with braking', async () => {
  const sent = []
  const input = new controlInput.ControlInput({
    allowVehicleActions: false, send: async (value) => { sent.push(controlInput.toV2ControlCommand(value)) },
    onChange: () => {}, onError: (error) => { throw error },
  })
  const monitor = new controlInput.GamepadInput(input, () => {})
  const pad = {
    index: 0, id: 'standard-test-pad', mapping: 'standard', connected: true,
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
  }
  try {
    input.setAvailable(true)
    monitor.setMapping(controlInput.v2GamepadMapping)
    monitor.poll([pad], true)
    monitor.confirmMapping(true)
    monitor.setEnabled(true)
    monitor.poll([pad], true)
    pad.buttons[4].pressed = true
    pad.axes[0] = 0.575
    pad.axes[3] = -0.575
    monitor.poll([pad], true)
    await flush()
    assert.deepEqual(sent.at(-1), { steering: 500, throttle: 500, brake: 0, direction: 1 })
    pad.buttons[4].pressed = false
    monitor.poll([pad], true)
    await flush()
    assert.deepEqual(sent.at(-1), { steering: 0, throttle: 0, brake: 1000, direction: 0 })
  } finally { input.setAvailable(false) }
})

test('camera grouping preserves pending direction, manual override and single-track compatibility', () => {
  const view = new cameraView.CameraView()
  view.gear('GEAR_DRIVE')
  view.command({ mode: 'high_level', action: 'reverse' })
  view.gear('GEAR_DRIVE')
  assert.equal(view.group, 'rear')
  assert.match(view.status, /请求中/)
  view.command({ mode: 'high_level', action: 'stop' })
  view.gear(undefined)
  assert.equal(view.group, 'rear')
  view.setMode('front')
  view.gear('GEAR_REVERSE')
  assert.equal(view.group, 'front')
  view.setMode('auto')
  assert.equal(view.group, 'rear')
  view.clearIntent()
  view.gear('GEAR_DRIVE')
  assert.equal(view.group, 'front')
  assert.deepEqual(cameraView.visibleCameras('front', { front: true }).map(value => value.name), ['front'])
  assert.deepEqual(cameraView.visibleCameras('front', { front: true, center: true }).map(value => value.name),
    ['left', 'center', 'right'])
  assert.deepEqual(cameraView.visibleCameras('rear', { front: true }).map(value => value.name),
    ['rear-left', 'rear-center', 'rear-right'])
  assert.equal(cameraView.trackCameraName('camera-rear-center'), 'rear-center')
  assert.equal(cameraView.trackCameraName('camera0'), 'front')
  assert.equal(cameraView.trackCameraName('unknown'), undefined)
})

test('Data contracts preserve unknown health, enforce vehicle identity and bounded counters', () => {
  const data = dataAPI.createPreviewData('car-test')
  assert.equal(data.can_manage, false)
  assert.equal(data.health.payload.sample.message.require_emergency_stop, null)
  assert.equal(dataAPI.healthFreshness(data, 0).fresh, true)
  assert.equal(dataAPI.healthFreshness(data, 4000).fresh, false)
  const unknown = structuredClone(data)
  unknown.health.payload.sample.source_timestamp_ms = null
  assert.equal(dataAPI.healthFreshness(unknown, 0).fresh, false)
  const truncated = structuredClone(data)
  truncated.health.payload.sample.message.components_truncated = true
  assert.equal(dataAPI.healthFreshness(truncated, 0).fresh, false)
  const future = structuredClone(data)
  future.health.payload.published_at_ms += 1000
  assert.equal(dataAPI.healthFreshness(future, 0).fresh, false)
  const mismatched = structuredClone(data)
  mismatched.events[0].vehicle_id = 'another-car'
  assert.equal(dataAPI.vehicleDataSchema.safeParse(mismatched).success, false)
  assert.equal(dataAPI.vehicleDataSchema.safeParse({ ...data, arbitrary: true }).success, false)
  const event = data.events[0]
  assert.equal(dataAPI.dataEventSchema.safeParse({ ...event, transition: 'recovered' }).success, false)
  const diagnostics = {
    schema_version: 1, type: 'vehicle_data_diagnostics', vehicle_id: 'car-test', stream_id: 'boot',
    sequence: 1, published_at_ms: 1000, store: {
      capacity: 100, outbox_retained: 80, outbox_pending: 2, inbox_retained: 10, inbox_pending: 1, faults_retained: 0,
    },
  }
  assert.equal(dataAPI.diagnosticsSchema.safeParse(diagnostics).success, true)
  diagnostics.store.outbox_pending = 81
  assert.equal(dataAPI.diagnosticsSchema.safeParse(diagnostics).success, false)
})

test('Data query generation preserves typed boundaries and unknown status', () => {
  const task = dataAPI.newDataQuery('car-test', 'map', 'target-epoch', 'target-id', 1000)
  assert.equal(task.operation, 'query')
  assert.equal(task.expires_at_ms, 61000)
  assert.notEqual(task.request_id, dataAPI.newDataQuery('car-test', 'map', 'target-epoch', 'target-id', 1000).request_id)
  assert.equal(dataAPI.dataTaskSchema.safeParse({ ...task, operation: 'safety_reset' }).success, false)
  assert.equal(dataAPI.dataTaskSchema.safeParse({ ...task, expires_at_ms: 1000 }).success, false)
  assert.throws(() => dataAPI.newDataQuery('car-test', 'map', 'bad/epoch', 'target', 1000))
  const report = { request_id: task.request_id, report_sequence: 3, status: 'unknown', reason: 'query pending', mission_result: null }
  assert.equal(dataAPI.taskReportSchema.parse(report).status, 'unknown')
})

test('Data HTTP mutations use exact persistence codes, preserve retries and expose permission failures', async () => {
  const original = globalThis.fetch
  const calls = []
  const task = dataAPI.newDataQuery('car-test', 'map', 'epoch', 'request')
  try {
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options })
      return new Response(null, { status: 202 })
    }
    await dataAPI.submitDataQuery(task, 'test-bearer')
    await dataAPI.submitDataQuery(task, 'test-bearer')
    assert.equal(calls[0].options.body, calls[1].options.body)
    assert.ok(calls[0].url.endsWith('/api/vehicles/car-test/data/tasks'))
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-bearer')
    globalThis.fetch = async () => new Response(null, { status: 204 })
    await dataAPI.acknowledgeDataEvent('car-test', 'event-1', 'test-bearer')
    await assert.rejects(() => dataAPI.submitDataQuery(task, 'test-bearer'), /持久化确认/)
    globalThis.fetch = async () => new Response('denied', { status: 403 })
    await assert.rejects(() => dataAPI.acknowledgeDataEvent('car-test', 'event-1', 'test-bearer'),
      (error) => error.status === 403)
    globalThis.fetch = async () => new Response('full', { status: 507 })
    await assert.rejects(() => dataAPI.submitDataQuery(task, 'test-bearer'), /容量已满/)
    globalThis.fetch = async () => { throw new Error('disconnected') }
    await assert.rejects(() => dataAPI.submitDataQuery(task, 'test-bearer'), /结果未知/)
    await assert.rejects(() => dataAPI.submitDataQuery({ ...task, operation: 'simulate_wait',
      parameters: { duration_ms: 1, target_request_id: null, target_client_epoch: null } }, 'test-bearer'), /只读/)
  } finally { globalThis.fetch = original }
})

test('Data fetching rejects wrong-vehicle payloads and propagates cancellation', async () => {
  const original = globalThis.fetch
  try {
    globalThis.fetch = async () => Response.json(dataAPI.createPreviewData('wrong-car'))
    await assert.rejects(() => dataAPI.fetchVehicleData('car-test', 'test-bearer'), /身份不匹配/)
    globalThis.fetch = async () => new Response('{broken', { status: 200 })
    await assert.rejects(() => dataAPI.fetchVehicleData('car-test', 'test-bearer'), /JSON/)
    const controller = new AbortController()
    globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })
      controller.abort()
    })

    await assert.rejects(() => dataAPI.fetchVehicleData('car-test', 'test-bearer', controller.signal),
      (error) => error.name === 'AbortError')
  } finally { globalThis.fetch = original }
})

test('Data export follows bounded cursors and never downloads mixed vehicles or incomplete pages', async () => {
  const original = globalThis.fetch
  const event = dataAPI.createPreviewData('car-test').events[0]
  const calls = []
  try {
    globalThis.fetch = async (url) => {
      calls.push(url)
      const after = new URL(url).searchParams.get('after')
      return Response.json({
        vehicle_id: 'car-test', kind: 'events', through: 2, next: after === '0' ? 1 : 2,
        has_more: after === '0',
        records: [{ cursor: after === '0' ? 1 : 2, payload: { ...event, event_id: `event-${after}` }, acknowledgement: null }],
      })

    }
    const output = await dataAPI.exportDataRecords('car-test', 'events', 'test-bearer')
    assert.equal(output.split('\n').length, 2)
    assert.ok(calls[1].endsWith('kind=events&after=1&through=2'))
    globalThis.fetch = async () => Response.json({ vehicle_id: 'car-test', kind: 'events', through: 2,
      next: 0, has_more: true, records: [] })
    await assert.rejects(() => dataAPI.exportDataRecords('car-test', 'events', 'test-bearer'), /游标/)
    globalThis.fetch = async () => Response.json({ vehicle_id: 'car-test', kind: 'events', through: 1,
      next: 1, has_more: false, records: [{ cursor: 1, payload: { ...event, vehicle_id: 'another' }, acknowledgement: null }] })
    await assert.rejects(() => dataAPI.exportDataRecords('car-test', 'events', 'test-bearer'), /身份/)
  } finally { globalThis.fetch = original }
})

test('Data requests bound stalled response bodies and preserve unknown mutation outcomes', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const original = globalThis.fetch
  let signal
  globalThis.fetch = async (_url, options) => {
    signal = options.signal
    return { ok: true, status: 202, text: () => new Promise(() => {}) }
  }
  try {
    const task = dataAPI.newDataQuery('car-test', 'map', 'epoch', 'target')
    const rejection = assert.rejects(() => dataAPI.submitDataQuery(task, 'test-bearer'), /结果未知/)
    await flush()
    context.mock.timers.tick(8000)
    await rejection
    assert.equal(signal.aborted, true)
  } finally { globalThis.fetch = original; context.mock.timers.reset() }
})

test('Data preview renders Monitor and task panels with every mutation disabled and no requests', async () => {
  const { outputFiles } = await esbuild.build({
    stdin: {
      contents: `import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
        import Panel from './src/pages/VehicleDataPanel';
        import {MockFleetProvider} from './src/app/MockFleetProvider';
        export const render = (mode) => renderToStaticMarkup(<MockFleetProvider><Panel vehicleId="car-test" preview mode={mode} /></MockFleetProvider>);`,
      resolveDir: process.cwd(), loader: 'tsx',
    },
    bundle: true, format: 'cjs', platform: 'node', write: false,
  })
  const module = { exports: {} }
  new Function('require', 'module', 'exports', outputFiles[0].text)(createRequire(import.meta.url), module, module.exports)
  const original = globalThis.fetch
  let requests = 0
  try {
    globalThis.fetch = async () => { ++requests; throw new Error('preview must not request') }
    for (const mode of ['details', 'alerts', 'tasks']) {
      const html = module.exports.render(mode)
      assert.match(html, /固定预览/)
      assert.match(html, /Monitor/)
      for (const [button] of html.matchAll(/<button\b[^>]*>/g)) assert.match(button, /disabled/)
      if (mode === 'tasks') assert.match(html, /只读查询/)
    }
    assert.equal(requests, 0)
  } finally { globalThis.fetch = original }
})

test('v2 canonical signing rejects float and conflicting pedal commands', () => {
  const payload = {
    version: 2, type: 'control', vehicle_id: 'car-test', session_id: 'session-test',
    client_instance_id: 'browser-test', receiver_instance_id: 'a'.repeat(32),
    revision: 1, sequence: 1, timestamp_ms: 1700000000000,
    command: { steering: -1000, throttle: 1000, brake: 0, direction: -1 },
  }
  assert.equal(new TextDecoder().decode(controlProtocol.controlSignBytes(payload)),
    `[2,"control","car-test","session-test","browser-test","${'a'.repeat(32)}",1,1,1700000000000,-1000,1000,0,-1]`)
  assert.throws(() => controlProtocol.controlSignBytes({ ...payload, command: { ...payload.command, throttle: 0.1 } }))
  assert.throws(() => controlProtocol.controlSignBytes({ ...payload, command: { ...payload.command, brake: 1 } }))
})

function controllerFixture(renewAfter = 10000) {
  let instanceId
  let sequence = 0
  const calls = []
  const session = {
    session_id: 'e0dfe6c0-63ee-416d-81b1-689bf10c785d', vehicle_id: 'car-test',
    protocol_version: 2, sender_identity: 'control-e0dfe6c0-63ee-416d-81b1-689bf10c785d',
    status: 'ACTIVE',
  }

  const connection = {
    connect: async () => { calls.push('connect') },
    publish: async (body) => {
      sequence = JSON.parse(new TextDecoder().decode(body)).sequence
      calls.push('publish')
    },
    disconnect: async () => { calls.push('disconnect') },
  }
  const request = async (url, options) => {
    if (url.endsWith('/acquire')) {
      instanceId = JSON.parse(options.body).client_instance_id
      return Response.json({ session: { ...session, client_instance_id: instanceId }, token: 'test-token', renew_after_ms: renewAfter })
    }
    if (url.endsWith('/release')) { calls.push('release'); return Response.json({ state: 'PENDING' }, { status: 202 }) }
    if (url.endsWith('/handover')) {
      calls.push('handover')
      return Response.json({ vehicle_id: 'car-test', session_id: session.session_id, state: 'CONFIRMED', vehicle_handover_confirmed: true })
    }
    throw new Error('Unexpected request')
  }
  const controller = new ControlSessionClient('car-test', 'http://localhost', 'test-bearer', connection, () => {}, request)
  const feedback = () => ({
    version: 2, type: 'control.feedback', vehicle_id: 'car-test', session_id: session.session_id,
    receiver_instance_id: 'a'.repeat(32), revision: 1, accepted_sequence: sequence,
    status: 'READY', reason: 'awaiting_command', last_rejection: '', simulation: true, command: null,
  })
  const accept = (data = feedback(), sender = 'vehicle-car-test') =>
    controller.acceptFeedback(sender, true, new TextEncoder().encode(JSON.stringify(data)))
  return { controller, connection, calls, feedback, accept, request }
}

test('default control HTTP transport does not bind browser fetch to the controller', async context => {
  const f = controllerFixture()
  let controller
  context.mock.method(globalThis, 'fetch', function (...args) {
    assert.notEqual(this, controller, 'native browser fetch rejects a controller receiver')
    return f.request(...args)
  })
  controller = new ControlSessionClient('car-test', 'http://localhost', 'test', f.connection, () => {})
  try {
    await controller.acquire()
    assert.equal(controller.state, 'connecting')
  } finally { await controller.release() }
})

test('acquire conflicts explain the fence and allow only an explicit retry without releasing another session', async () => {
  for (const [reason, detail] of [
    ['control lease is already held', /控制权已被占用/],
    ['previous vehicle handover is not confirmed', /上一次车辆交接尚未确认/],
    ['unexpected proxy response with private data', /^Control API: HTTP 409$/],
  ]) {
    const f = controllerFixture()
    let conflict = true
    let requests = 0
    const controller = new ControlSessionClient('car-test', 'http://localhost', 'test', f.connection, () => {},
      async (...args) => {
        requests++
        if (conflict) return new Response(reason, { status: 409 })
        return f.request(...args)
      })
    try {
      await assert.rejects(controller.acquire(), /HTTP 409/)
      assert.equal(controller.state, 'idle')
      assert.match(controller.error, detail)
      await controller.tick()
      assert.equal(requests, 1, 'conflicts must not trigger automatic retries')
      assert.deepEqual(f.calls, [], 'a rejected acquire owns no RTC connection or lease')
      conflict = false
      await controller.acquire()
      assert.equal(controller.state, 'connecting')
      assert.equal(controller.error, '')
      assert.deepEqual(f.calls, ['connect'])
    } finally { await controller.release() }
  }
})

test('a late acquire conflict cannot undo a camera safety lock', async () => {
  const f = controllerFixture()
  let rejectAcquire
  const controller = new ControlSessionClient('car-test', 'http://localhost', 'test', f.connection, () => {},
    () => new Promise(resolve => { rejectAcquire = resolve }))
  const acquiring = controller.acquire()
  const rejected = assert.rejects(acquiring, /HTTP 409/)
  while (!rejectAcquire) await new Promise(resolve => setImmediate(resolve))
  controller.setMediaReady(false)
  rejectAcquire(new Response('control lease is already held', { status: 409 }))
  await rejected
  assert.equal(controller.state, 'locked')
  controller.setMediaReady(true)
  assert.equal(controller.state, 'locked')
  assert.deepEqual(f.calls, [])
  await controller.release()
})

test('camera feed readiness needs three advancing decoded streams and clears on stall and detach', (context) => {
  let now = 1000
  context.mock.method(performance, 'now', () => now)
  context.mock.timers.enable({ apis: ['setInterval'] })
  const listeners = new Map()
  let callback, cancelled, attached = false
  const video = {
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: name => listeners.delete(name),
    requestVideoFrameCallback: fn => { callback = fn; return 7 },
    cancelVideoFrameCallback: id => { cancelled = id },
  }
  const frames = {}
  const stop = cameraFeed.bindCameraFeed({
    attach: () => { attached = true },
    detach: () => { attached = false },
  }, video, live => { frames.center = live })
  try {
    assert.equal(attached, true)
    assert.equal(cameraFeed.threeCamerasReady(frames), false, 'track arrival is not frame readiness')
    callback()
    frames.left = frames.right = true
    assert.equal(cameraFeed.threeCamerasReady(frames), true)
    listeners.get('waiting')()
    assert.equal(cameraFeed.threeCamerasReady(frames), false)
    callback()
    now += cameraFeed.CAMERA_FRAME_TIMEOUT_MS
    context.mock.timers.tick(100)
    assert.equal(cameraFeed.threeCamerasReady(frames), false)
    callback()
    assert.equal(cameraFeed.threeCamerasReady(frames), true)
    stop()
    assert.equal(cameraFeed.threeCamerasReady(frames), false)
    assert.equal(cancelled, 7)
    assert.equal(attached, false)
    assert.equal(listeners.size, 0)
    callback()
    assert.equal(cameraFeed.threeCamerasReady(frames), false, 'late callback cannot restore detached feed')
  } finally { stop(); context.mock.timers.reset() }
})

test('video loss fences v2 control and restored frames cannot rearm the session', async () => {
  const blocked = controllerFixture()
  blocked.controller.setMediaReady(false)
  await assert.rejects(blocked.controller.acquire(), /camera feeds/)
  assert.deepEqual(blocked.calls, [])
  const f = controllerFixture()
  await f.controller.acquire()
  f.accept()
  f.controller.setCommand({ steering: 0, throttle: 100, brake: 0, direction: 1 })
  f.controller.setMediaReady(false)
  assert.equal(f.controller.state, 'locked')
  await f.controller.tick()
  assert.equal(f.calls.includes('publish'), false)
  f.controller.setMediaReady(true)
  f.accept()
  assert.equal(f.controller.state, 'locked')
  assert.throws(() => f.controller.setCommand(controlProtocol.neutralCommand))
  await f.controller.release()
})

test('video loss during connection cannot be overwritten by late RTC completion', async () => {
  const f = controllerFixture()
  let complete
  f.connection.connect = () => new Promise(resolve => { complete = resolve })
  const acquiring = f.controller.acquire()
  while (!complete) await new Promise(resolve => setImmediate(resolve))
  f.controller.setMediaReady(false)
  complete()
  await acquiring
  assert.equal(f.controller.state, 'locked')
  f.controller.setMediaReady(true)
  f.accept()
  assert.equal(f.controller.state, 'locked')
  await f.controller.release()
})

test('controller requires bound feedback, signs commands, and fences switching through release', async () => {
  const f = controllerFixture()
  await f.controller.acquire()
  try {
    assert.throws(() => f.controller.setCommand(controlProtocol.neutralCommand))
    f.accept(f.feedback(), 'vehicle-another')
    assert.equal(f.controller.state, 'connecting')
    f.accept()
    assert.equal(f.controller.state, 'ready')
    f.controller.setCommand({ steering: 0, throttle: 100, brake: 0, direction: 1 })
    await f.controller.tick()
    assert.ok(f.calls.includes('publish'))
    f.accept({ ...f.feedback(), receiver_instance_id: 'b'.repeat(32) })
    assert.equal(f.controller.state, 'locked')
    f.accept()
    assert.equal(f.controller.state, 'locked', 'feedback must not silently rearm')
    await f.controller.release()
    assert.equal(f.controller.state, 'closed')
    assert.ok(f.calls.indexOf('disconnect') < f.calls.indexOf('release'))
    assert.ok(f.calls.indexOf('release') < f.calls.indexOf('handover'))
  } finally { await f.controller.release() }
})

test('release during in-flight connection cannot leave a connected controller behind', async () => {
  const f = controllerFixture()
  let connected
  const waiting = new Promise((resolve) => { connected = resolve })
  f.connection.connect = async () => { await waiting; f.calls.push('late-connect') }
  const acquiring = f.controller.acquire()
  while (f.controller.state !== 'connecting') await new Promise((resolve) => setTimeout(resolve, 1))
  await f.controller.release()
  connected()
  await acquiring
  assert.equal(f.calls.at(-1), 'disconnect')
  assert.equal(f.controller.state, 'closed')
})

test('stale feedback and stalled publication latch control off without queuing commands', async (context) => {
  let now = 1000
  context.mock.method(performance, 'now', () => now)
  const f = controllerFixture()
  await f.controller.acquire()
  f.accept()
  let finish
  let publishing = false
  f.connection.publish = async () => {
    publishing = true
    await new Promise((resolve) => { finish = resolve })
  }
  const sending = f.controller.tick()
  while (!publishing) await new Promise((resolve) => setImmediate(resolve))
  now += 300
  await f.controller.tick()
  assert.equal(f.controller.state, 'locked')
  assert.match(f.controller.error, /stalled/)
  finish()
  await sending
  f.accept()
  assert.equal(f.controller.state, 'locked')
  await f.controller.release()
  const second = controllerFixture()
  await second.controller.acquire()
  second.accept()
  now += 751
  await second.controller.tick()
  assert.equal(second.controller.state, 'locked')
  assert.match(second.controller.error, /feedback timed out/)
  await second.controller.release()
})

test('control acquire timeout covers stalled response bodies', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let requested = false
  const controller = new ControlSessionClient('car-test', 'http://localhost', 'test', {
    connect: async () => {}, publish: async () => {}, disconnect: async () => {},
  }, () => {}, async () => {
    requested = true
    return { ok: true, status: 200, json: () => new Promise(() => {}) }
  })
  try {
    const acquiring = controller.acquire()
    const rejection = assert.rejects(acquiring, /timed out/)
    while (!requested) await new Promise((resolve) => setImmediate(resolve))
    context.mock.timers.tick(3000)
    await rejection
    assert.equal(controller.state, 'locked')
    await controller.release()
    assert.equal(controller.state, 'closed', 'failed acquire must not strand the local target')
  } finally { context.mock.timers.reset() }
})

test('releasing the deadman while signing cannot publish a stale pressed command', async (context) => {
  const f = controllerFixture()
  await f.controller.acquire()
  f.accept()
  const sign = crypto.subtle.sign.bind(crypto.subtle)
  let signing = false
  let finish
  context.mock.method(crypto.subtle, 'sign', async (...args) => {
    const signature = await sign(...args)
    signing = true
    await new Promise((resolve) => { finish = resolve })
    return signature
  })
  f.controller.setCommand({ steering: 0, throttle: 100, brake: 0, direction: 1 })
  const sending = f.controller.tick()
  while (!signing) await new Promise((resolve) => setImmediate(resolve))
  f.controller.setCommand(controlProtocol.neutralCommand)
  finish()
  await sending
  assert.equal(f.calls.includes('publish'), false)
  await f.controller.release()
})

test('repeated identical input samples do not cancel an in-flight signature', async context => {
  const f = controllerFixture()
  await f.controller.acquire()
  f.accept()
  const sign = crypto.subtle.sign.bind(crypto.subtle)
  let signing = false, finish
  context.mock.method(crypto.subtle, 'sign', async (...args) => {
    const signature = await sign(...args)
    signing = true
    await new Promise(resolve => { finish = resolve })
    return signature
  })
  const command = { steering: 0, throttle: 100, brake: 0, direction: 1 }
  f.controller.setCommand(command)
  const sending = f.controller.tick()
  while (!signing) await new Promise(resolve => setImmediate(resolve))
  f.controller.setCommand({ ...command })
  finish()
  await sending
  assert.equal(f.calls.includes('publish'), true)
  await f.controller.release()
})

test('sign completion enforces the exact send deadline without an intervening tick', async context => {
  let now = 1000
  context.mock.method(performance, 'now', () => now)
  const sign = crypto.subtle.sign.bind(crypto.subtle)
  let delay = 0
  context.mock.method(crypto.subtle, 'sign', async (...args) => {
    const signature = await sign(...args)
    now += delay
    return signature
  })
  for (delay of [249, 250, 300]) {
    const f = controllerFixture()
    try {
      await f.controller.acquire()
      f.accept()
      await f.controller.tick()
      assert.equal(f.calls.includes('publish'), delay < 250)
      assert.equal(f.controller.state, delay < 250 ? 'ready' : 'locked')
      if (delay >= 250) {
        assert.match(f.controller.error, /stalled/)
        assert.ok(f.calls.includes('disconnect'))
      }
    } finally { await f.controller.release() }
  }
})

test('sign completion checks lease and feedback deadlines before enqueue', async context => {
  let now = 1000, delay = 0
  context.mock.method(performance, 'now', () => now)
  const sign = crypto.subtle.sign.bind(crypto.subtle)
  context.mock.method(crypto.subtle, 'sign', async (...args) => {
    const signature = await sign(...args)
    now += delay
    return signature
  })
  for (const [renewAfter, elapsed] of [[200, 400], [10000, 751]]) {
    const f = controllerFixture(renewAfter)
    try {
      await f.controller.acquire()
      f.accept()
      delay = elapsed
      await f.controller.tick()
      assert.equal(f.calls.includes('publish'), false)
      assert.match(f.controller.error, /lease or vehicle feedback timed out/)
    } finally { await f.controller.release() }
  }
})

test('late publication completion locks and disconnects before a timer gets to run', async context => {
  let now = 1000
  context.mock.method(performance, 'now', () => now)
  const f = controllerFixture()
  const publish = f.connection.publish
  f.connection.publish = async body => { await publish(body); now += 250 }
  try {
    await f.controller.acquire()
    f.accept()
    await f.controller.tick()
    assert.equal(f.controller.state, 'locked')
    assert.match(f.controller.error, /stalled/)
    assert.equal(f.calls.filter(call => call === 'publish').length, 1)
    assert.ok(f.calls.includes('disconnect'))
  } finally { await f.controller.release() }
})

test('superseded signatures leave unique sequence gaps without creating ACK debt', async context => {
  const f = controllerFixture()
  const sign = crypto.subtle.sign.bind(crypto.subtle)
  let supersede = true, throttle = 0
  context.mock.method(crypto.subtle, 'sign', async (...args) => {
    const signature = await sign(...args)
    if (supersede) {
      throttle = throttle ? 0 : 1
      f.controller.setCommand({ steering: 0, throttle, brake: 0, direction: 1 })
    }
    return signature
  })
  try {
    await f.controller.acquire()
    f.accept()
    for (let i = 0; i < 7; i++) await f.controller.tick()
    assert.equal(f.calls.includes('publish'), false)
    f.accept()
    assert.equal(f.controller.state, 'ready')
    supersede = false
    await f.controller.tick()
    assert.equal(f.feedback().accepted_sequence, 8)
    f.accept()
    assert.equal(f.controller.state, 'ready')
    assert.equal(f.controller.diagnostics.filter(event => event.event === 'superseded').length, 7)
    assert.equal(f.controller.diagnostics.at(-1).pending_commands, 0)
  } finally { await f.controller.release() }
})

test('feedback cannot acknowledge a signature that was never dispatched', async context => {
  const f = controllerFixture()
  const sign = crypto.subtle.sign.bind(crypto.subtle)
  context.mock.method(crypto.subtle, 'sign', async (...args) => {
    const signature = await sign(...args)
    f.controller.setCommand({ steering: 1, throttle: 0, brake: 0, direction: 0 })
    return signature
  })
  try {
    await f.controller.acquire()
    f.accept()
    await f.controller.tick()
    f.accept({ ...f.feedback(), accepted_sequence: 1 })
    assert.equal(f.controller.state, 'locked')
    assert.equal(f.controller.error, 'Unexpected control acknowledgement')
  } finally { await f.controller.release() }
})

test('repeated feedback cannot reset dispatch progress and a late ACK cannot revive it', async context => {
  let now = 1000
  context.mock.method(performance, 'now', () => now)
  for (const lateAck of [false, true]) {
    const f = controllerFixture()
    try {
      await f.controller.acquire()
      f.accept()
      await f.controller.tick()
      for (let i = 0; i < 4; i++) {
        now += 100
        f.accept({ ...f.feedback(), accepted_sequence: 0 })
        assert.equal(f.controller.state, 'ready')
      }
      now += 50
      if (lateAck) f.accept()
      else await f.controller.tick()
      assert.equal(f.controller.state, 'locked')
      assert.match(f.controller.error, /acknowledgement progress timed out/)
    } finally { await f.controller.release() }
  }
})

test('timely cumulative ACKs retire dispatched commands and record application response time', async context => {
  let now = 1000
  context.mock.method(performance, 'now', () => now)
  const f = controllerFixture()
  try {
    await f.controller.acquire()
    f.accept()
    await f.controller.tick()
    now += 100
    await f.controller.tick()
    now += 349
    f.accept()
    assert.equal(f.controller.state, 'ready')
    assert.equal(f.controller.diagnostics.findLast(event => event.event === 'ack').duration_ms, 349)
    now += 100
    f.accept()
    await f.controller.tick()
    assert.equal(f.controller.state, 'ready')
  } finally { await f.controller.release() }
})

test('ACK during publication is recognized before the publish promise resolves', async () => {
  const f = controllerFixture()
  const publish = f.connection.publish
  f.connection.publish = async body => { await publish(body); f.accept() }
  try {
    await f.controller.acquire()
    f.accept()
    await f.controller.tick()
    assert.equal(f.controller.state, 'ready')
    assert.equal(f.controller.feedback.accepted_sequence, 1)
    assert.equal(f.controller.diagnostics.at(-1).pending_commands, 0)
  } finally { await f.controller.release() }
})

test('release while signing discards the command even if the promise later succeeds', async context => {
  const f = controllerFixture()
  const sign = crypto.subtle.sign.bind(crypto.subtle)
  context.mock.method(crypto.subtle, 'sign', async (...args) => {
    const signature = await sign(...args)
    await f.controller.release()
    return signature
  })
  await f.controller.acquire()
  f.accept()
  await f.controller.tick()
  assert.equal(f.controller.state, 'closed')
  assert.equal(f.calls.includes('publish'), false)
})

test('faults retain the first cause through RTC failure, failed release and successful retry', async () => {
  const f = controllerFixture()
  const disconnect = f.connection.disconnect
  try {
    await f.controller.acquire()
    f.accept()
    f.connection.disconnect = async () => { throw new Error('private transport details') }
    f.controller.fail('stale_command')
    f.controller.fail('RTC disconnected')
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(f.controller.error, 'stale_command')
    assert.match(f.controller.cleanupError, /disconnect failed/)
    assert.ok(!f.controller.cleanupError.includes('private'))
    await assert.rejects(f.controller.release(), /Control release failed; vehicle handover is not confirmed/)
    assert.equal(f.controller.state, 'pending')
    assert.equal(f.controller.error, 'stale_command')
    f.connection.disconnect = disconnect
    await f.controller.release()
    assert.equal(f.controller.state, 'closed')
    assert.equal(f.controller.error, 'stale_command')
    assert.equal(f.controller.cleanupError, '')
  } finally { f.connection.disconnect = disconnect; await f.controller.release() }
})

test('timing snapshots are bounded, independent copies without commands or credentials', async context => {
  let now = 1000
  context.mock.method(performance, 'now', () => now)
  const f = controllerFixture()
  try {
    await f.controller.acquire()
    f.accept()
    for (let i = 0; i < 70; i++) {
      await f.controller.tick()
      now += 1
      f.accept()
    }
    const trace = f.controller.diagnostics
    assert.equal(trace.length, 128)
    assert.equal(f.controller.state, 'ready')
    trace[0].event = 'mutated'
    assert.notEqual(f.controller.diagnostics[0].event, 'mutated')
    assert.doesNotMatch(JSON.stringify(trace), /test-bearer|test-token|signature|throttle|private/)
    assert.ok(trace.some(event => event.event === 'ack' && event.duration_ms === 1))
  } finally { await f.controller.release() }
})

test('unacknowledged dispatch storage has a hard count bound even during a rapid burst', async context => {
  context.mock.method(performance, 'now', () => 1000)
  const f = controllerFixture()
  try {
    await f.controller.acquire()
    f.accept()
    for (let i = 0; i < 65; i++) await f.controller.tick()
    assert.equal(f.calls.filter(call => call === 'publish').length, 64)
    assert.equal(f.controller.state, 'locked')
    assert.match(f.controller.error, /Too many unacknowledged/)
  } finally { await f.controller.release() }
})

test('local clock steps are diagnostic only and cannot extend a monotonic ACK deadline', async context => {
  let now = 1000, wall = 1_700_000_000_000
  context.mock.method(performance, 'now', () => now)
  context.mock.method(Date, 'now', () => wall)
  for (const step of [-5000, -250, -100, 100, 250, 5000]) {
    const f = controllerFixture()
    try {
      await f.controller.acquire()
      f.accept()
      await f.controller.tick()
      now += 449
      wall += 449 + step
      f.accept({ ...f.feedback(), accepted_sequence: 0 })
      assert.equal(f.controller.state, 'ready')
      assert.equal(f.controller.diagnostics.at(-1).wall_elapsed_delta_ms, step)
      now += 1
      wall += 1
      f.accept()
      assert.equal(f.controller.state, 'locked')
      assert.equal(f.controller.diagnostics.at(-1).fault_code, 'ack_timeout')
    } finally { await f.controller.release() }
  }
})

const sample = {
  age_ms: 100,
  source_timestamp_ms: 1_700_000_000_000,
  source_sequence: 4,
  message: { speed_mps: 2, steering_percentage: -3 },
}

const entry = {
  vehicle_id: 'fleet-1',
  name: 'Test vehicle',
  state: {
    schema_version: 1,
    type: 'vehicle_telemetry',
    vehicle_id: 'fleet-1',
    stream_id: 'stream-1',
    sequence: 10,
    published_at_ms: 1_700_000_000_100,
    chassis: sample,
    localization: {
      age_ms: 100,
      source_timestamp_ms: 1_700_000_000_000,
      source_sequence: 5,
      message: { position: { x: 1, y: 2, z: 3 }, heading_rad: 1.2, frame_id: 'map' },
    },
  },
  received_at_ms: 1_700_000_000_200,
  server_time_ms: 1_700_000_000_300,
  online: true,
  control: { status: 'free', is_self: false },
}

test('validates the strict telemetry envelope and matching directory identity', () => {
  assert.equal(api.vehicleEntrySchema.safeParse(entry).success, true)
  assert.equal(api.vehicleEntrySchema.safeParse({ ...entry, unexpected: true }).success, false)
  assert.equal(
    api.vehicleEntrySchema.safeParse({
      ...entry,
      state: { ...entry.state, vehicle_id: 'another-vehicle' },
    }).success,
    false,
  )
})

test('rejects invalid numbers and out-of-range steering values', () => {
  const invalid = {
    ...entry,
    state: {
      ...entry.state,
      chassis: {
        ...entry.state.chassis,
        message: { speed_mps: Number.POSITIVE_INFINITY, steering_percentage: 101 },
      },
    },
  }
  assert.equal(api.vehicleEntrySchema.safeParse(invalid).success, false)
})

test('computes source freshness from server timestamps and elapsed receipt time', () => {
  const received = {
    ...entry,
    receivedAtClientMs: 50_000,
    receivedAtWallMs: 1_700_000_000_300,
  }
  const sampleAtServer = {
    age_ms: 1_000,
    source_timestamp_ms: entry.server_time_ms - 1_000,
    source_sequence: 1,
    message: null,
  }

  assert.deepEqual(
    telemetry.getSampleFreshness(sampleAtServer, received, 52_500),
    {
      receiptAgeMs: 2_500,
      sourceAgeMs: 3_700,
      callbackAgeMs: 3_700,
      gatewayStateAgeMs: 2_600,
      publisherTransitAgeMs: 2_700,
      state: 'fresh',
    },
  )
  assert.equal(telemetry.getSampleFreshness(sampleAtServer, received, 60_000).state, 'stale')
})

test('old persisted snapshots stay stale across fresh directory polls', () => {
  const firstResponse = {
    ...entry,
    received_at_ms: entry.server_time_ms - 12_000,
    server_time_ms: entry.server_time_ms,
    receivedAtClientMs: 100_000,
    receivedAtWallMs: 1_700_000_000_300,
  }
  const freshSource = {
    ...sample,
    source_timestamp_ms: firstResponse.server_time_ms - 500,
    age_ms: 500,
  }
  const secondResponse = {
    ...firstResponse,
    server_time_ms: firstResponse.server_time_ms + 2_000,
    receivedAtClientMs: 102_000,
    receivedAtWallMs: 1_700_000_002_300,
  }

  assert.equal(telemetry.getSampleFreshness(freshSource, firstResponse, 100_000).state, 'stale')
  assert.equal(telemetry.getSampleFreshness(freshSource, secondResponse, 102_000).state, 'stale')
  assert.equal(
    telemetry.getSampleFreshness(freshSource, secondResponse, 102_000).gatewayStateAgeMs,
    14_000,
  )
})

test('missing source timestamps remain unknown while showing callback age', () => {
  const received = { ...entry, receivedAtClientMs: 1_000, receivedAtWallMs: 1_000 }
  const ageOnly = { ...sample, source_timestamp_ms: null }
  const freshness = telemetry.getSampleFreshness(ageOnly, received, 2_000)
  assert.equal(freshness.state, 'unknown')
  assert.equal(freshness.callbackAgeMs, 1_300)
  const unknown = { ...ageOnly, age_ms: null }
  assert.equal(telemetry.getSampleFreshness(unknown, received, 2_000).callbackAgeMs, null)
})

test('future sample, packet and receipt clocks are reported as clock errors', () => {
  const received = { ...entry, receivedAtClientMs: 1_000, receivedAtWallMs: 1_000 }
  const futureTimestamp = {
    ...sample,
    source_timestamp_ms: entry.server_time_ms + 10_000,
  }
  assert.equal(telemetry.getSampleFreshness(futureTimestamp, received, 2_000).state, 'clock-error')
  assert.equal(
    telemetry.getSampleFreshness(sample, {
      ...received,
      state: { ...entry.state, published_at_ms: entry.server_time_ms + 10_000 },
    }, 2_000).state,
    'clock-error',
  )
  assert.equal(
    telemetry.getSampleFreshness(sample, { ...received, received_at_ms: entry.server_time_ms + 10_000 }, 2_000).state,
    'clock-error',
  )
})

test('a stale callback age cannot be overridden by a fresh source timestamp', () => {
  const received = { ...entry, receivedAtClientMs: 1_000, receivedAtWallMs: 1_000 }
  const freshness = telemetry.getSampleFreshness(
    { ...sample, age_ms: 8_000, source_timestamp_ms: entry.server_time_ms - 100 },
    received,
    2_000,
  )
  assert.equal(freshness.callbackAgeMs, 9_200)
  assert.equal(freshness.state, 'stale')
})

test('directory online status ages out between polls and fails closed on errors', () => {
  const received = { ...entry, receivedAtClientMs: 10_000, receivedAtWallMs: 1_700_000_000_300 }
  assert.equal(telemetry.directoryOnline(received, false, 10_000), true)
  assert.equal(telemetry.directoryOnline(received, false, 21_000), false)
  assert.equal(telemetry.directoryOnline(received, true, 10_000), false)
  const oldReceipt = { ...received, received_at_ms: entry.server_time_ms - 9_000 }
  assert.equal(telemetry.directoryOnline(oldReceipt, false, 10_000), true)
  assert.equal(telemetry.directoryOnline(oldReceipt, false, 12_000), false)
  assert.equal(telemetry.directoryOnline({ ...received, received_at_ms: null }, false, 10_000), false)
  assert.equal(
    telemetry.directoryOnline({ ...received, received_at_ms: entry.server_time_ms + 1 }, false, 10_000),
    false,
  )
})

test('callback age adds persisted packet age and full elapsed request time', () => {
  const received = {
    ...entry,
    receivedAtClientMs: 10_000,
    receivedAtWallMs: 1_700_000_000_300,
    received_at_ms: entry.server_time_ms - 2_500,
    state: { ...entry.state, published_at_ms: entry.server_time_ms - 3_000 },
  }
  const freshness = telemetry.getSampleFreshness(
    { ...sample, age_ms: 2_000, source_timestamp_ms: entry.server_time_ms },
    received,
    12_000,
  )
  assert.equal(freshness.callbackAgeMs, 7_000)
  assert.equal(freshness.sourceAgeMs, 7_000)
  assert.equal(freshness.state, 'stale')
})

test('directory occupancy becomes unknown on failure or stale directory response', () => {
  const received = { ...entry, receivedAtClientMs: 10_000, receivedAtWallMs: 1_700_000_000_300 }
  assert.equal(telemetry.directoryControl(received, false, 10_000).status, 'free')
  assert.deepEqual(telemetry.directoryControl(received, true, 10_000), {
    status: 'unknown',
    is_self: false,
  })

  const occupied = { ...received, control: { status: 'occupied', is_self: true } }
  assert.equal(telemetry.directoryControl(occupied, false, 21_000).status, 'unknown')
  assert.equal(telemetry.directoryControl(occupied, true, 10_000).status, 'unknown')
})

test('validates bounded read-only vehicle operations and preview fixtures with the live schema', () => {
  const fixture = operations.createPreviewOperations('fleet-1')
  assert.equal(operations.vehicleOperationsSchema.safeParse(fixture).success, true)
  assert.equal(
    operations.vehicleOperationsSchema.safeParse({
      ...fixture,
      capabilities: { ...fixture.capabilities, driving: true },
    }).success,
    false,
  )
  assert.equal(
    operations.vehicleOperationsSchema.safeParse({
      ...fixture,
      history: Array(301).fill(fixture.history[0]),
    }).success,
    false,
  )
  const samples = [
    { ...fixture.history[0], stream_id: 'stream-a', sequence: 1, received_at_ms: 10 },
    { ...fixture.history[0], stream_id: 'stream-a', sequence: 4, received_at_ms: 20 },
    { ...fixture.history[0], stream_id: 'stream-b', sequence: 1, received_at_ms: 30 },
  ]
  const continuity = operations.recentHistoryWithMarkers(samples)
  assert.equal(continuity[0].marker.kind, 'stream')
  assert.match(continuity[1].marker.label, /序号缺口/)
  const ageAtReceipt = operations.conservativeAgeMs(500, 10_000, 12_500)
  const ageOneSecondLater = operations.conservativeAgeMs(500, 10_000, 13_500)
  assert.equal(ageAtReceipt, 3_000)
  assert.equal(ageOneSecondLater, ageAtReceipt + 1_000)
  assert.equal(operations.conservativeAgeMs(null, 10_000, 12_500), null)
  const vehicles = preview.createPreviewVehicles()
  assert.equal(vehicles.entries.length, 2)
  assert.equal(vehicles.entries.every(({ receivedAtClientMs, receivedAtWallMs, ...vehicle }) =>
    api.vehicleEntrySchema.safeParse(vehicle).success), true)
})

test('business operations request is read-only, scoped, bearer-authenticated and uncached', async () => {
  const originalFetch = globalThis.fetch
  let observedUrl
  let observedOptions
  const responseBody = operations.createPreviewOperations('fleet-1')
  globalThis.fetch = async (url, options) => {
    observedUrl = String(url)
    observedOptions = options
    return new Response(JSON.stringify(responseBody))
  }
  try {
    await operations.fetchVehicleOperations('fleet-1', 'test-bearer')
    assert.match(observedUrl, /\/api\/vehicles\/fleet-1\/operations$/)
    assert.equal(observedOptions.method, undefined)
    assert.equal(observedOptions.cache, 'no-store')
    assert.equal(observedOptions.headers.Authorization, `Bearer ${'test-bearer'}`)
    await assert.rejects(operations.fetchVehicleOperations('../other', 'test-bearer'))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('operations rejects malformed identifiers, zero timestamps and oversized UTF-8 mission descriptions', () => {
  const fixture = operations.createPreviewOperations('fleet-1')
  const mutations = [
    { server_time_ms: 0 },
    { alerts: [{ ...fixture.alerts[0], event_id: 'preview-id' }] },
    { missions: [{ ...fixture.missions[0], mission_id: '../mission' }] },
    { missions: [{ ...fixture.missions[0], updated_at_ms: 0 }] },
    { missions: [{ ...fixture.missions[0], description: '车'.repeat(683) }] },
    { history: [{ ...fixture.history[0], stream_id: '' }] },
    { history: [{ ...fixture.history[0], sequence: 0 }] },
  ]
  for (const mutation of mutations) {
    assert.equal(operations.vehicleOperationsSchema.safeParse({ ...fixture, ...mutation }).success, false)
  }
  assert.equal(operations.vehicleOperationsSchema.safeParse({
    ...fixture,
    diagnostics: { ...fixture.diagnostics, chassis_age_ms: 0 },
    missions: [{ ...fixture.missions[0], description: '车'.repeat(682) }],
  }).success, true)
})

test('all fixed preview scenarios use live contracts and preserve unknown, stale and recovery semantics', () => {
  const now = 1_793_333_000_000
  const expectedFreshness = { stale: 'stale', missing: 'unknown', clock: 'clock-error' }
  for (const scenario of preview.previewScenarios.filter((value) => value !== 'default')) {
    const vehicles = preview.createPreviewVehicles(now, scenario)
    for (const received of vehicles.entries) {
      const business = operations.createPreviewOperations(received.vehicle_id, now, scenario)
      assert.equal(operations.vehicleOperationsSchema.safeParse(business).success, true, scenario)
      assert.equal(telemetry.getSampleFreshness(
        received.state.chassis, received, received.receivedAtClientMs,
      ).state, expectedFreshness[scenario] ?? 'fresh', scenario)
      assert.equal(received.online, scenario !== 'stale', scenario)
      assert.deepEqual(business.history[0].chassis, received.state.chassis.message, scenario)
      assert.equal(business.history[0].stream_id, received.state.stream_id, scenario)
      assert.equal(business.history[0].sequence, received.state.sequence, scenario)
      if (scenario === 'missing' || scenario === 'clock') assert.equal(business.diagnostics.chassis_age_ms, null)
      if (scenario === 'error') assert.equal(business.alerts[0].status, 'open')
      if (scenario === 'recovered') assert.equal(business.alerts[0].status, 'resolved')
      if (scenario === 'mission-unknown') assert.equal(business.missions[0].status, 'unknown')
      if (scenario === 'history') assert.deepEqual(
        operations.recentHistoryWithMarkers(business.history).slice(0, 2).map((item) => item.marker.kind),
        ['stream', 'gap'],
      )
    }
  }
})

test('rejects an operations response belonging to a different requested vehicle', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(JSON.stringify(
    operations.createPreviewOperations('another-vehicle'),
  ))
  try {
    await assert.rejects(operations.fetchVehicleOperations('fleet-1', 'test-bearer'), /格式不符/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('operations requests abort on timeout instead of falling back to preview data', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const originalFetch = globalThis.fetch
  let signal
  globalThis.fetch = async (_url, options) => {
    signal = options.signal
    return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })
  }
  try {
    const request = operations.fetchVehicleOperations('fleet-1', 'test-bearer')
    const rejection = assert.rejects(request, /请求超时/)
    await flush()
    context.mock.timers.tick(operations.OPERATIONS_REQUEST_TIMEOUT_MS)
    await rejection
    assert.equal(signal.aborted, true)
  } finally {
    globalThis.fetch = originalFetch
    context.mock.timers.reset()
  }
})

test('uses bearer auth and URL-encodes detail IDs', async () => {
  const originalFetch = globalThis.fetch
  let observedUrl
  let observedAuthorization
  let observedCache
  globalThis.fetch = async (url, options) => {
    observedUrl = String(url)
    observedAuthorization = options.headers.Authorization
    observedCache = options.cache
    return new Response(JSON.stringify(entry), { status: 200 })
  }
  try {
    await api.fetchVehicle('fleet / one', 'secret-test-token')
    assert.match(observedUrl, /fleet%20%2F%20one\/state$/)
    assert.equal(observedCache, 'no-store')
    assert.equal(observedAuthorization, 'Bearer secret-test-token')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('pending directory requests time out explicitly without signing out', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
  })
  try {
    const request = api.fetchVehicles('token')
    const rejection = assert.rejects(request, /请求超时.*自动重试/)
    context.mock.timers.tick(api.VEHICLES_REQUEST_TIMEOUT_MS)
    await rejection
  } finally {
    globalThis.fetch = originalFetch
    context.mock.timers.reset()
  }
})

test('surfaces explicit authorization failures', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => new Response('', { status: 403 })
  try {
    await assert.rejects(api.fetchVehicles('token'), /无权查看授权车辆目录/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

const sessionId = 'c0d0f0aa-8847-4901-97ad-35b766490a01'
const requestId = 'de6ad5ab-adc5-4765-a8d2-d5d00d17f639'
const clientInstanceId = '598324e0-0f47-4be3-a93f-016a5fbc3c62'
const viewingResponse = {
  vehicle_id: 'fleet-1',
  viewing_session_id: sessionId,
  expires_at_ms: 1_700_000_030_000,
  server_time_ms: 1_700_000_000_000,
  renew_after_ms: 10_000,
  token: 'test-livekit-token',
}
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve() }

function lifecycleHarness(overrides = {}, optionOverrides = {}) {
  const calls = { acquired: [], released: [], renewed: [], errors: [], disconnected: 0, created: 0, connected: 0, cleanupErrors: 0 }
  const lease = {
    ...viewingResponse,
    vehicle_id: optionOverrides.vehicleId ?? 'fleet-1',
    viewing_session_id: optionOverrides.sessionId ?? sessionId,
    deadlineMs: performance.now() + 30_000,
  }
  const options = {
    vehicleId: 'fleet-1',
    bearer: 'original-bearer',
    clientInstanceId,
    createObserver() {
      calls.created++
      return {
        connect: async () => {},
        disconnect: async () => { calls.disconnected++ },
      }
    },
    onConnected: () => { calls.connected++ },
    onError: (error) => { calls.errors.push(error) },
    onCleanupError: () => { calls.cleanupErrors++ },
    ...optionOverrides,
  }
  const lifecycle = new ViewingLifecycle(options, {
    acquire: async (...args) => { calls.acquired.push(args); return lease },
    renew: async (...args) => {
      calls.renewed.push(args)
      const advance = 10_000 * calls.renewed.length
      return {
        ...lease,
        expires_at_ms: lease.expires_at_ms + advance,
        server_time_ms: lease.server_time_ms + advance,
        deadlineMs: performance.now() + 30_000,
      }
    },
    release: async (...args) => { calls.released.push(args) },
    ...overrides,
  })
  return { lifecycle, calls, options, lease }
}

test('viewing requests use POST, no-store, original bearer, stable IDs and empty renew/release bodies', async () => {
  const originalFetch = globalThis.fetch
  const calls = []
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), ...options })
    if (String(url).endsWith('/release')) return new Response(null, { status: 204 })
    const { token, ...renewal } = viewingResponse
    return new Response(JSON.stringify(String(url).endsWith('/acquire') ? viewingResponse : renewal))
  }
  try {
    const start = performance.now()
    const acquired = await viewing.acquireViewing('fleet-1', 'original-bearer', requestId, clientInstanceId)
    assert.ok(acquired.deadlineMs >= start + 30_000)
    assert.ok(acquired.deadlineMs <= performance.now() + 30_000)
    await viewing.renewViewing('fleet-1', sessionId, 'original-bearer')
    await viewing.releaseViewing('fleet-1', sessionId, 'original-bearer')
    assert.deepEqual(JSON.parse(calls[0].body), { request_id: requestId, client_instance_id: clientInstanceId })
    for (const call of calls) {
      assert.equal(call.method, 'POST')
      assert.equal(call.cache, 'no-store')
      assert.equal(call.headers.Authorization, 'Bearer original-bearer')
    }
    assert.equal(calls[1].body, undefined)
    assert.equal(calls[2].body, undefined)
    assert.equal(calls[2].keepalive, true)
    assert.match(calls[1].url, new RegExp(`/viewing/${sessionId}/renew$`))
  } finally { globalThis.fetch = originalFetch }
})

test('viewing validates strict identities, lease deadlines and response shape', async () => {
  const originalFetch = globalThis.fetch
  try {
    const { token, ...renewal } = viewingResponse
    for (const invalid of [
      { ...renewal, vehicle_id: 'other' },
      { ...renewal, viewing_session_id: 'malformed' },
      { ...renewal, viewing_session_id: clientInstanceId },
      { ...renewal, expires_at_ms: renewal.server_time_ms },
      { ...renewal, expires_at_ms: renewal.server_time_ms + 30_001 },
      { ...renewal, server_time_ms: Infinity },
      { ...renewal, renew_after_ms: 0 },
      { ...renewal, token: 'unexpected' },
    ]) {
      globalThis.fetch = async () => new Response(JSON.stringify(invalid))
      await assert.rejects(viewing.renewViewing('fleet-1', sessionId, 'bearer'), /无效/)
    }
    const calls = []
    globalThis.fetch = async (url) => {
      calls.push(String(url))
      return String(url).endsWith('/release')
        ? new Response(null, { status: 204 })
        : new Response(JSON.stringify({ ...viewingResponse, unexpected: true }))
    }
    await assert.rejects(viewing.acquireViewing('fleet-1', 'bearer', requestId, clientInstanceId), /响应无效/)
    assert.match(calls[1], /\/release$/)
  } finally { globalThis.fetch = originalFetch }
})

test('viewing deadline subtracts full RTT without relying on browser wall clock', async (context) => {
  const originalFetch = globalThis.fetch
  context.mock.method(performance, 'now', () => 1_000)
  globalThis.fetch = async () => {
    context.mock.method(performance, 'now', () => 3_000)
    return new Response(JSON.stringify(viewingResponse))
  }
  try {
    const lease = await viewing.acquireViewing('fleet-1', 'bearer', requestId, clientInstanceId)
    assert.equal(lease.deadlineMs, 31_000)
    assert.equal(lease.deadlineMs - performance.now(), 28_000)
  } finally {
    globalThis.fetch = originalFetch
    context.mock.restoreAll()
  }
})

test('viewing requests time out and abort even when fetch ignores cancellation', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const originalFetch = globalThis.fetch
  let signal
  globalThis.fetch = async (_url, options) => {
    signal = options.signal
    return new Promise(() => {})
  }
  try {
    const request = viewing.acquireViewing('fleet-1', 'bearer', requestId, clientInstanceId)
    const rejection = assert.rejects(request, /请求超时/)
    context.mock.timers.tick(viewing.VIEWING_REQUEST_TIMEOUT_MS)
    await rejection
    assert.equal(signal.aborted, true)
  } finally {
    globalThis.fetch = originalFetch
    context.mock.timers.reset()
  }
})

test('viewing timeout covers a stalled response body and renew/release requests', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) })
  try {
    for (const request of [
      () => viewing.acquireViewing('fleet-1', 'bearer', requestId, clientInstanceId),
      () => viewing.renewViewing('fleet-1', sessionId, 'bearer'),
      () => viewing.releaseViewing('fleet-1', sessionId, 'bearer'),
    ]) {
      const rejection = assert.rejects(request(), /请求超时/)
      await flush()
      context.mock.timers.tick(viewing.VIEWING_REQUEST_TIMEOUT_MS)
      await rejection
    }
  } finally {
    globalThis.fetch = originalFetch
    context.mock.timers.reset()
  }
})

test('only the exact requested vehicle participant can provide video', () => {
  assert.equal(viewing.isVehicleVideoSender('vehicle-fleet-1', 'fleet-1'), true)
  for (const identity of ['vehicle-fleet-2', 'observer-' + sessionId, 'fleet-1', 'vehicle-fleet-1-extra', '', undefined]) {
    assert.equal(viewing.isVehicleVideoSender(identity, 'fleet-1'), false)
  }
})

test('renewal failure stops observing and releases with the captured bearer', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const { lifecycle, calls } = lifecycleHarness({ renew: async () => { throw new Error('renew denied') } })
  try {
    await lifecycle.start()
    assert.equal(calls.created, 1)
    context.mock.timers.tick(10_000)
    await flush()
    assert.equal(lifecycle.active, false)
    assert.equal(calls.disconnected, 1)
    assert.deepEqual(calls.released, [['fleet-1', sessionId, 'original-bearer']])
    assert.match(calls.errors[0].message, /renew denied/)
    context.mock.timers.tick(60_000)
    await flush()
    assert.equal(calls.released.length, 1)
  } finally { await lifecycle.stop(); context.mock.timers.reset() }
})

test('stale or regressed renewal timestamps fail closed before extending the local deadline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  try {
    for (const advancesExpiry of [false, true]) {
      const { lifecycle, calls, lease } = lifecycleHarness({
        renew: async (...args) => {
          calls.renewed.push(args)
          return {
            ...lease,
            expires_at_ms: lease.expires_at_ms + (advancesExpiry ? 10_000 : 0),
            server_time_ms: lease.server_time_ms + (advancesExpiry ? -1 : 0),
            deadlineMs: performance.now() + 30_000,
          }
        },
      })
      await lifecycle.start()
      context.mock.timers.tick(10_000)
      await flush()
      assert.equal(calls.renewed.length, 1)
      assert.equal(lifecycle.active, false)
      assert.equal(calls.disconnected, 1)
      assert.equal(calls.released.length, 1)
      assert.match(calls.errors[0].message, /未推进服务端租约状态/)
    }
  } finally { context.mock.timers.reset() }
})

test('late acquire after cancellation releases without constructing a Room', async () => {
  const pending = deferred()
  const { lifecycle, calls, lease } = lifecycleHarness({ acquire: () => pending.promise })
  const starting = lifecycle.start()
  await lifecycle.stop()
  pending.resolve(lease)
  await starting
  assert.equal(calls.created, 0)
  assert.equal(calls.errors.length, 0)
  assert.deepEqual(calls.released, [['fleet-1', sessionId, 'original-bearer']])
})

test('Room connection and construction failures do not leak acquired leases', async () => {
  for (const constructionFails of [false, true]) {
    let disconnected = 0
    const { lifecycle, calls } = lifecycleHarness({}, {
      createObserver() {
        if (constructionFails) throw new Error('construction failed')
        return {
          connect: async () => { throw new Error('connect failed') },
          disconnect: async () => { disconnected++ },
        }
      },
    })
    await lifecycle.start()
    await lifecycle.stop()
    assert.equal(calls.released.length, 1)
    assert.equal(disconnected, constructionFails ? 0 : 1)
    assert.equal(calls.errors.length, 1)
  }
})

test('auth-switch cleanup retains the old bearer and cannot disconnect a newer attempt', async () => {
  const oldConnection = deferred()
  let oldDisconnects = 0
  const old = lifecycleHarness({}, {
    createObserver: () => ({
      connect: () => oldConnection.promise,
      disconnect: async () => { oldDisconnects++ },
    }),
  })

  const starting = old.lifecycle.start()
  await flush()
  await old.lifecycle.stop()
  const current = lifecycleHarness({}, { bearer: 'new-login-bearer' })
  try {
    await current.lifecycle.start()
    oldConnection.reject(new Error('stale connection failure'))
    await starting
    await flush()
    assert.equal(oldDisconnects, 1)
    assert.equal(old.calls.errors.length, 0)
    assert.deepEqual(old.calls.released[0], ['fleet-1', sessionId, 'original-bearer'])
    assert.equal(current.lifecycle.active, true)
    assert.equal(current.calls.disconnected, 0)
  } finally { await current.lifecycle.stop() }
  assert.equal(current.calls.released[0][2], 'new-login-bearer')
})

test('renewals remain serial and the hard TTL stops a stalled renewal', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const pending = deferred()
  let renewals = 0
  const { lifecycle, calls } = lifecycleHarness({
    renew: () => { renewals++; return pending.promise },
  })
  try {
    await lifecycle.start()
    context.mock.timers.tick(10_000)
    await flush()
    context.mock.timers.tick(10_000)
    await flush()
    assert.equal(renewals, 1)
    context.mock.timers.tick(10_000)
    await flush()
    assert.equal(lifecycle.active, false)
    assert.equal(calls.disconnected, 1)
    assert.equal(calls.released.length, 1)
    pending.resolve({ ...viewingResponse, deadlineMs: performance.now() + 30_000 })
    await flush()
    context.mock.timers.tick(30_000)
    await flush()
    assert.equal(renewals, 1)
  } finally { await lifecycle.stop(); context.mock.timers.reset() }
})

test('late Room connect success after cancel is disconnected again without a ready callback', async () => {
  const pending = deferred()
  let disconnected = 0
  const { lifecycle, calls } = lifecycleHarness({}, {
    createObserver: () => ({
      connect: () => pending.promise,
      disconnect: async () => { disconnected++ },
    }),
  })
  const starting = lifecycle.start()
  await flush()
  await lifecycle.stop()
  await starting
  pending.resolve()
  await flush()
  assert.equal(disconnected, 2)
  assert.equal(calls.connected, 0)
  assert.equal(calls.released.length, 1)
})

test('connection timeout releases the lease and reports an error', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const { lifecycle, calls } = lifecycleHarness({}, {
    createObserver: () => ({ connect: () => new Promise(() => {}), disconnect: async () => {} }),
  })
  try {
    const starting = lifecycle.start()
    await flush()
    context.mock.timers.tick(15_000)
    await starting
    await lifecycle.stop()
    assert.equal(calls.released.length, 1)
    assert.match(calls.errors[0].message, /LiveKit 超时/)
    assert.equal(calls.connected, 0)
  } finally { await lifecycle.stop(); context.mock.timers.reset() }
})

test('release failure reports cleanup error instead of silently abandoning the lease', async () => {
  const { lifecycle, calls } = lifecycleHarness({ release: async () => { throw new Error('offline') } })
  await lifecycle.start()
  await lifecycle.stop()
  assert.equal(calls.disconnected, 1)
  assert.equal(calls.cleanupErrors, 1)
})

test('a delayed renewal timer cannot start a request after the monotonic deadline', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 1_000
  context.mock.method(performance, 'now', () => now)
  const { lifecycle, calls } = lifecycleHarness()
  try {
    await lifecycle.start()
    // Advance the clock without delivering expiry timers, as in a suspended tab.
    now = 31_000
    assert.equal(lifecycle.active, false)
    context.mock.timers.tick(10_000)
    await flush()
    assert.equal(calls.renewed.length, 0)
    assert.equal(calls.disconnected, 1)
    assert.equal(calls.released.length, 1)
    assert.equal(calls.errors.length, 1)
    context.mock.timers.tick(60_000)
    await flush()
    assert.equal(calls.errors.length, 1)
  } finally { await lifecycle.stop(); context.mock.restoreAll(); context.mock.timers.reset() }
})

test('late renewal cannot revive an expired deadline before the expiry timer runs', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 1_000
  context.mock.method(performance, 'now', () => now)
  const renewal = deferred()
  const connecting = deferred()
  let renewals = 0
  let disconnected = 0
  const { lifecycle, calls } = lifecycleHarness({
    renew: () => { renewals++; return renewal.promise },
  }, {
    createObserver: () => ({
      connect: () => connecting.promise,
      disconnect: async () => { disconnected++ },
    }),
  })
  try {
    const starting = lifecycle.start()
    await flush()
    now = 11_000
    context.mock.timers.tick(10_000)
    await flush()
    assert.equal(renewals, 1)
    now = 31_001
    assert.equal(lifecycle.active, false)
    renewal.resolve({ ...viewingResponse, deadlineMs: now + 30_000 })
    await flush()
    await starting
    assert.equal(calls.connected, 0)
    assert.equal(disconnected, 1)
    assert.equal(calls.released.length, 1)
    assert.equal(calls.errors.length, 1)
    assert.match(calls.errors[0].message, /租约已过期/)
    connecting.resolve()
    await flush()
    context.mock.timers.tick(60_000)
    await flush()
    assert.equal(renewals, 1)
    assert.equal(calls.connected, 0)
    assert.equal(calls.errors.length, 1)
  } finally { await lifecycle.stop(); context.mock.restoreAll(); context.mock.timers.reset() }
})

test('connection completion after expiry fails closed without waiting for timers', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 1_000
  context.mock.method(performance, 'now', () => now)
  const connecting = deferred()
  let disconnected = 0
  const { lifecycle, calls } = lifecycleHarness({}, {
    createObserver: () => ({
      connect: () => connecting.promise,
      disconnect: async () => { disconnected++ },
    }),
  })
  try {
    const starting = lifecycle.start()
    await flush()
    now = 31_000
    connecting.resolve()
    await starting
    await flush()
    assert.equal(calls.connected, 0)
    assert.equal(disconnected, 1)
    assert.equal(calls.released.length, 1)
    assert.equal(calls.errors.length, 1)
  } finally { await lifecycle.stop(); context.mock.restoreAll(); context.mock.timers.reset() }
})

test('a timely renewal updates the monotonic deadline used by active and later renewals', async (context) => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  let now = 1_000
  context.mock.method(performance, 'now', () => now)
  const { lifecycle, calls } = lifecycleHarness()
  try {
    await lifecycle.start()
    now = 11_000
    context.mock.timers.tick(10_000)
    await flush()
    now = 31_000
    assert.equal(lifecycle.active, true)
    context.mock.timers.tick(10_000)
    await flush()
    assert.equal(calls.renewed.length, 2)
    assert.equal(calls.errors.length, 0)
    now = 61_000
    assert.equal(lifecycle.active, false)
  } finally { await lifecycle.stop(); context.mock.restoreAll(); context.mock.timers.reset() }
})

test('independent vehicle observers keep their own lease and Room cleanup lifecycle', async () => {
  const firstSessionId = 'c0d0f0aa-8847-4901-97ad-35b766490a01'
  const secondSessionId = 'c0d0f0aa-8847-4901-97ad-35b766490a02'
  const first = lifecycleHarness({}, {
    vehicleId: 'fleet-1',
    sessionId: firstSessionId,
    createObserver: () => ({
      connect: async () => {},
      disconnect: async () => { first.calls.disconnected++ },
    }),
  })
  const second = lifecycleHarness({}, {
    vehicleId: 'fleet-2',
    sessionId: secondSessionId,
    createObserver: () => ({
      connect: async () => {},
      disconnect: async () => { second.calls.disconnected++ },
    }),
  })
  await Promise.all([first.lifecycle.start(), second.lifecycle.start()])
  await first.lifecycle.stop()
  assert.equal(first.lifecycle.active, false)
  assert.equal(first.calls.disconnected, 1)
  assert.equal(first.calls.released.length, 1)
  assert.deepEqual(first.calls.released[0], ['fleet-1', firstSessionId, 'original-bearer'])
  assert.equal(second.lifecycle.active, true)
  assert.equal(second.calls.disconnected, 0)
  assert.equal(second.calls.released.length, 0)
  await second.lifecycle.stop()
  assert.equal(second.calls.disconnected, 1)
  assert.deepEqual(second.calls.released[0], ['fleet-2', secondSessionId, 'original-bearer'])
})
