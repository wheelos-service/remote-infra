import assert from 'node:assert/strict'
import { test } from 'node:test'
import * as esbuild from 'esbuild'
import { webcrypto } from 'node:crypto'
import { createRequire } from 'node:module'
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
    { in: 'src/lib/simulation-controller.ts', out: 'simulation-controller' },
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
const { SimulationController } = await loadBundle('simulation-controller')

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
        export const render = (mode) => renderToStaticMarkup(<Panel vehicleId="car-test" preview mode={mode} />);`,
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

function controllerFixture() {
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
      return Response.json({ session: { ...session, client_instance_id: instanceId }, token: 'test-token', renew_after_ms: 10000 })
    }
    if (url.endsWith('/release')) { calls.push('release'); return Response.json({ state: 'PENDING' }, { status: 202 }) }
    if (url.endsWith('/handover')) {
      calls.push('handover')
      return Response.json({ vehicle_id: 'car-test', session_id: session.session_id, state: 'CONFIRMED', vehicle_handover_confirmed: true })
    }
    throw new Error('Unexpected request')
  }
  const controller = new SimulationController('car-test', 'http://localhost', 'test-bearer', connection, () => {}, request)
  const feedback = () => ({
    version: 2, type: 'control.feedback', vehicle_id: 'car-test', session_id: session.session_id,
    receiver_instance_id: 'a'.repeat(32), revision: 1, accepted_sequence: sequence,
    status: 'READY', reason: 'awaiting_command', last_rejection: '', simulation: true, command: null,
  })
  const accept = (data = feedback(), sender = 'vehicle-car-test') =>
    controller.acceptFeedback(sender, true, new TextEncoder().encode(JSON.stringify(data)))
  return { controller, connection, calls, feedback, accept }
}

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
  const controller = new SimulationController('car-test', 'http://localhost', 'test', {
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
