import assert from 'node:assert/strict'
import http from 'node:http'
import { test } from 'node:test'
import { createPublicKey, randomBytes, randomUUID, verify, webcrypto } from 'node:crypto'
import * as esbuild from 'esbuild'

globalThis.crypto ??= webcrypto

// Start a real loopback HTTP Gateway stub first so teleopConfig picks up its origin.
const state = {
  viewingAcquireAttempts: 0,
  controlAcquireAttempts: 0,
  viewing503Count: 0,
  control503Count: 0,
  maintenance503: false,
  conflict409: false,
  viewingLease: null,
  controlSession: null,
  handoverConfirmed: false,
  handoverPolls: 0,
  tokenRefreshes: 0,
  renewCount: 0,
  clockSkewMs: 10_000,
}

const server = http.createServer(async (req, res) => {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const json = (code, payload) => {
    res.writeHead(code, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(payload))
  }
  const nowServer = () => Date.now() + state.clockSkewMs

  if (url.pathname === '/api/vehicles/car-e2e/viewing/acquire' && req.method === 'POST') {
    state.viewingAcquireAttempts++
    if (state.maintenance503) {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      return res.end('MANAGED_MAINTENANCE_REQUIRED')
    }
    if (state.viewing503Count > 0) {
      state.viewing503Count--
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      return res.end('transient unavailable')
    }
    const serverTime = nowServer()
    state.viewingLease = {
      vehicle_id: 'car-e2e',
      viewing_session_id: randomUUID(),
      expires_at_ms: serverTime + 30_000,
      server_time_ms: serverTime,
      renew_after_ms: 10_000,
    }
    return json(200, { ...state.viewingLease, token: `observer-token-${state.viewingAcquireAttempts}` })
  }

  if (url.pathname.match(/^\/api\/vehicles\/car-e2e\/viewing\/[^/]+\/renew$/) && req.method === 'POST') {
    state.renewCount++
    if (!state.viewingLease) {
      res.writeHead(409)
      return res.end('viewing lease expired or released')
    }
    const serverTime = nowServer()
    state.viewingLease = {
      ...state.viewingLease,
      expires_at_ms: serverTime + 30_000,
      server_time_ms: serverTime,
    }
    return json(200, state.viewingLease)
  }

  if (url.pathname.match(/^\/api\/vehicles\/car-e2e\/viewing\/[^/]+\/token$/) && req.method === 'POST') {
    state.tokenRefreshes++
    if (!state.viewingLease) {
      res.writeHead(409)
      return res.end('viewing lease expired or released')
    }
    return json(200, { ...state.viewingLease, token: `observer-token-refresh-${state.tokenRefreshes}` })
  }

  if (url.pathname.match(/^\/api\/vehicles\/car-e2e\/viewing\/[^/]+\/release$/) && req.method === 'POST') {
    state.viewingLease = null
    res.writeHead(204)
    return res.end()
  }

  if (url.pathname === '/api/vehicles/car-e2e/control/acquire' && req.method === 'POST') {
    state.controlAcquireAttempts++
    if (state.maintenance503) {
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      return res.end('MANAGED_MAINTENANCE_REQUIRED')
    }
    if (state.control503Count > 0) {
      state.control503Count--
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      return res.end('transient unavailable')
    }
    if (state.conflict409) {
      res.writeHead(409, { 'Content-Type': 'text/plain' })
      return res.end('control lease is already held')
    }
    const body = JSON.parse(raw)
    const sessionId = randomUUID()
    state.handoverConfirmed = false
    state.handoverPolls = 0
    state.controlSession = {
      session_id: sessionId,
      vehicle_id: 'car-e2e',
      protocol_version: 2,
      client_instance_id: body.client_instance_id,
      sender_identity: `control-${sessionId}`,
      status: 'ACTIVE',
      public_key_b64: body.public_key_b64,
    }
    const { public_key_b64: _, ...wireSession } = state.controlSession
    return json(200, {
      session: wireSession,
      token: `control-token-${sessionId}`,
      renew_after_ms: 5_000,
      server_time_ms: nowServer(),
      timing_policy: {
        control_tick_ms: 50,
        watchdog_pause_ms: 300,
        watchdog_lock_ms: 1500,
        rtc_reconnect_grace_ms: 1200,
        media_pause_grace_ms: 5000,
        ack_budget_ms: 600,
        feedback_timeout_ms: 1000,
        context_ttl_ms: 5000,
      },
    })
  }

  if (url.pathname.match(/^\/api\/control\/[^/]+\/renew$/) && req.method === 'POST') {
    if (!state.controlSession) {
      res.writeHead(404)
      return res.end('control session not found')
    }
    const { public_key_b64: _, ...wireSession } = state.controlSession
    return json(200, { session: wireSession, renew_after_ms: 5_000, server_time_ms: nowServer() })
  }

  if (url.pathname.match(/^\/api\/control\/[^/]+\/release$/) && req.method === 'POST') {
    res.writeHead(202)
    return res.end(JSON.stringify({ state: 'PENDING' }))
  }

  if (url.pathname === '/api/vehicles/car-e2e/control/handover' && req.method === 'GET') {
    state.handoverPolls++
    if (state.handoverPolls >= 2) state.handoverConfirmed = true
    return json(200, {
      vehicle_id: 'car-e2e',
      session_id: state.controlSession?.session_id ?? '',
      state: state.handoverConfirmed ? 'CONFIRMED' : 'PENDING',
      vehicle_handover_confirmed: state.handoverConfirmed,
    })
  }

  res.writeHead(404)
  res.end('not found')
})

await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const address = server.address()
const gatewayOrigin = `http://127.0.0.1:${address.port}`

globalThis.window = {
  location: { hostname: '127.0.0.1', origin: gatewayOrigin, search: '' },
  __LIVEKIT_INFRA_CONFIG__: { gatewayUrl: gatewayOrigin, livekitUrl: 'ws://127.0.0.1:7880' },
}

const built = await esbuild.build({
  entryPoints: [
    { in: 'src/lib/viewing-lifecycle.ts', out: 'viewing-lifecycle' },
    { in: 'src/lib/control-session-client.ts', out: 'control-session-client' },
    { in: 'src/lib/control-input-adapter.ts', out: 'control-input-adapter' },
    { in: 'src/lib/camera-feed.ts', out: 'camera-feed' },
    { in: 'src/lib/control-timing.ts', out: 'control-timing' },
  ],
  outdir: 'e2e-test-build',
  bundle: true,
  format: 'cjs',
  platform: 'node',
  write: false,
})
const load = name => {
  const mod = { exports: {} }
  const file = built.outputFiles.find(item => item.path.endsWith(`${name}.js`))
  new Function('module', 'exports', file.text)(mod, mod.exports)
  return mod.exports
}

const { ViewingLifecycle } = load('viewing-lifecycle')
const { ControlSessionClient } = load('control-session-client')
const { ControlInput, GamepadInput, bindKeyboardInput, toV2ControlCommand, v2GamepadMapping } = load('control-input-adapter')
const { bindCameraFeed, threeCamerasReady } = load('camera-feed')

function ed25519Verify(publicKeyB64, payloadJson) {
  const parsed = JSON.parse(payloadJson)
  const spkiPrefix = Buffer.from('302a300506032b6570032100', 'hex')
  const key = createPublicKey({
    key: Buffer.concat([spkiPrefix, Buffer.from(publicKeyB64, 'base64')]),
    format: 'der',
    type: 'spki',
  })
  const canonical = Buffer.from(JSON.stringify([
    parsed.version, parsed.type, parsed.vehicle_id, parsed.session_id,
    parsed.client_instance_id, parsed.receiver_instance_id, parsed.revision,
    parsed.sequence, parsed.timestamp_ms,
    parsed.command.steering, parsed.command.throttle, parsed.command.brake, parsed.command.direction,
  ]))
  assert.equal(verify(null, canonical, key, Buffer.from(parsed.signature, 'base64')), true, 'Ed25519 signature invalid')
  return parsed
}

function resetState() {
  state.viewingAcquireAttempts = 0
  state.controlAcquireAttempts = 0
  state.viewing503Count = 0
  state.control503Count = 0
  state.maintenance503 = false
  state.conflict409 = false
  state.viewingLease = null
  state.controlSession = null
  state.handoverConfirmed = false
  state.handoverPolls = 0
  state.tokenRefreshes = 0
  state.renewCount = 0
}

class FakeReceiver {
  constructor() {
    this.instanceId = randomBytes(16).toString('hex')
    this.sequence = 0
    this.paused = false
    this.lastCommand = null
  }
  readyFeedback(sessionId) {
    return new TextEncoder().encode(JSON.stringify({
      version: 2, type: 'control.feedback', vehicle_id: 'car-e2e', session_id: sessionId,
      receiver_instance_id: this.instanceId, revision: 1, accepted_sequence: this.sequence,
      status: this.paused ? 'PAUSED' : (this.sequence > 0 ? 'APPLIED' : 'READY'),
      reason: this.paused ? 'command_paused' : (this.sequence > 0 ? 'simulated_not_physical' : 'awaiting_command'),
      last_rejection: '', simulation: true, command: this.paused ? null : this.lastCommand,
    }))
  }
  accept(publicKeyB64, bodyBytes, serverNowMs) {
    const msg = ed25519Verify(publicKeyB64, new TextDecoder().decode(bodyBytes))
    assert.ok(msg.sequence > this.sequence, 'replay rejected')
    assert.ok(msg.timestamp_ms >= serverNowMs - 450 && msg.timestamp_ms <= serverNowMs + 150,
      `timestamp skew out of window: ${msg.timestamp_ms} vs ${serverNowMs}`)
    assert.ok(msg.command.steering >= -100 && msg.command.steering <= 100)
    assert.ok(msg.command.throttle >= 0 && msg.command.throttle <= 100)
    assert.ok(msg.command.brake >= 0 && msg.command.brake <= 100)
    if (this.paused) {
      assert.equal(msg.command.throttle, 0, 'recovery out of PAUSED must require throttle==0')
      this.paused = false
    }
    this.sequence = msg.sequence
    this.lastCommand = msg.command
    return this.readyFeedback(msg.session_id)
  }
}

test.after(() => server.close())

test('E2E Normal Flow: viewing acquire -> 3-camera rVFC ready -> gamepad 0-100 control -> handover release', async () => {
  resetState()
  const receiver = new FakeReceiver()
  const frames = { left: false, center: false, right: false }
  const frameStops = []
  let observerConnected = false
  const lifecycle = new ViewingLifecycle({
    vehicleId: 'car-e2e',
    bearer: 'test-bearer',
    clientInstanceId: randomUUID(),
    createObserver: () => ({
      connect: async () => {
        observerConnected = true
        for (const cam of ['left', 'center', 'right']) {
          let cb
          const video = {
            addEventListener: () => {},
            removeEventListener: () => {},
            requestVideoFrameCallback: fn => { cb = fn; return 1 },
            cancelVideoFrameCallback: () => {},
          }
          frameStops.push(bindCameraFeed({ attach: () => {}, detach: () => {} }, video,
            live => { frames[cam] = live }, { requireFrameCallback: true }))
          cb(performance.now(), { rtpTimestamp: 100, presentedFrames: 1 })
        }
      },
      disconnect: () => {},
    }),
    onRecovering: () => {},
    onConnected: () => {},
    onError: err => { throw err },
    onCleanupError: () => {},
  })

  await lifecycle.start()
  assert.equal(observerConnected, true)
  assert.equal(threeCamerasReady(frames), true)

  let controller
  const published = []
  controller = new ControlSessionClient('car-e2e', gatewayOrigin, 'test-bearer', {
    connect: async () => {
      setImmediate(() => controller.acceptFeedback('vehicle-car-e2e', true,
        receiver.readyFeedback(state.controlSession.session_id)))
    },
    publish: async body => {
      published.push(body)
      const fb = receiver.accept(state.controlSession.public_key_b64, body, Date.now() + state.clockSkewMs)
      controller.acceptFeedback('vehicle-car-e2e', true, fb)
    },
    disconnect: async () => {},
  }, () => {})
  controller.setMediaReady(true)
  await controller.acquire()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(controller.state, 'ready')

  // Wire GamepadInput -> ControlInput -> toV2ControlCommand -> ControlSessionClient
  const controls = new ControlInput({
    allowVehicleActions: false,
    send: async intent => {
      const cmd = toV2ControlCommand(intent)
      controller.setCommand(cmd)
      await controller.tick()
    },
    onChange: () => {},
    onError: err => { throw err },
  })
  const padInput = new GamepadInput(controls, () => {})
  padInput.setMapping(v2GamepadMapping)
  controls.setAvailable(true)
  const pad = {
    index: 0, id: 'pad-e2e', connected: true, mapping: 'standard',
    axes: [0, 0, 0, 0], buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })),
  }
  padInput.poll([pad], true)
  padInput.confirmMapping(true)
  padInput.setEnabled(true)
  padInput.poll([pad], true)
  pad.buttons[4].pressed = true
  pad.axes[0] = 0.575 // ~50% steer
  pad.axes[3] = -0.575 // ~50% throttle, forward
  padInput.poll([pad], true)
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.ok(published.length >= 1)
  assert.deepEqual(receiver.lastCommand, { steering: 50, throttle: 50, brake: 0, direction: 1 })

  // Neutralize, release and verify handover confirmation completes
  controls.setAvailable(false)
  await controller.neutralizeAndPublish()
  await controller.release()
  assert.equal(controller.state, 'closed')
  assert.equal(state.handoverConfirmed, true)

  for (const stop of frameStops) stop()
  await lifecycle.stop()
  assert.equal(state.viewingLease, null)
})

test('E2E Exception Flows: L0 503 retries & maintenance reject, L1 video rebuild, L1 RTC PAUSED + late ACK, and Space E-Stop', async () => {
  resetState()
  // 1. L0 transient 503 retries recover; maintenance 503 stops immediately
  state.viewing503Count = 2
  let observerEvents
  let rebuildCount = 0
  let recoverState = false
  const lifecycle = new ViewingLifecycle({
    vehicleId: 'car-e2e',
    bearer: 'test-bearer',
    clientInstanceId: randomUUID(),
    createObserver: (_token, events) => {
      observerEvents = events
      rebuildCount++
      return { connect: async () => {}, disconnect: () => {} }
    },
    onRecovering: () => { recoverState = true },
    onConnected: () => { recoverState = false },
    onError: err => { throw err },
    onCleanupError: () => {},
  })
  await lifecycle.start()
  assert.equal(state.viewingAcquireAttempts, 3, 'transient 503 should retry twice and succeed on 3rd attempt')

  // L1 Reconnecting -> Reconnected completes recovery immediately when 3 tracks stay live
  observerEvents.reconnecting()
  assert.equal(recoverState, true)
  observerEvents.reconnected()
  lifecycle.frameRendered()
  assert.equal(recoverState, false)

  // L1 Disconnected triggers /viewing/{id}/token refresh and Room rebuild without bumping expiry
  const initialExpiry = state.viewingLease.expires_at_ms
  observerEvents.disconnected()
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(state.tokenRefreshes, 1)
  assert.equal(rebuildCount, 2)
  assert.equal(state.viewingLease.expires_at_ms, initialExpiry)
  assert.equal(recoverState, true)
  lifecycle.frameRendered()
  assert.equal(recoverState, false)

  // 2. Maintenance 503 & 409 leave ControlSessionClient cleanly in idle (not locked)
  state.maintenance503 = true
  const maintCtrl = new ControlSessionClient('car-e2e', gatewayOrigin, 'test-bearer', {
    connect: async () => {}, publish: async () => {}, disconnect: async () => {},
  }, () => {})
  await assert.rejects(maintCtrl.acquire(), /维护排空/)
  assert.equal(maintCtrl.state, 'idle')
  assert.equal(state.controlAcquireAttempts, 1, 'maintenance 503 must not retry')

  state.maintenance503 = false
  state.conflict409 = true
  const conflictCtrl = new ControlSessionClient('car-e2e', gatewayOrigin, 'test-bearer', {
    connect: async () => {}, publish: async () => {}, disconnect: async () => {},
  }, () => {})
  await assert.rejects(conflictCtrl.acquire(), /控制权已被占用/)
  assert.equal(conflictCtrl.state, 'idle')

  // 3. L1 Control Reconnecting (<1.2s) + PAUSED feedback + late Reliable ACK + global Space E-Stop
  state.conflict409 = false
  state.control503Count = 1
  const receiver = new FakeReceiver()
  let heldFeedback = null
  let ctrl
  ctrl = new ControlSessionClient('car-e2e', gatewayOrigin, 'test-bearer', {
    connect: async () => {
      setImmediate(() => ctrl.acceptFeedback('vehicle-car-e2e', true,
        receiver.readyFeedback(state.controlSession.session_id)))
    },
    publish: async body => {
      const fb = receiver.accept(state.controlSession.public_key_b64, body, Date.now() + state.clockSkewMs)
      if (!heldFeedback) {
        heldFeedback = fb
      } else {
        ctrl.acceptFeedback('vehicle-car-e2e', true, fb)
      }
    },
    disconnect: async () => {},
  }, () => {})
  await ctrl.acquire()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(ctrl.state, 'ready')

  ctrl.setCommand({ steering: 15, throttle: 30, brake: 0, direction: 1 })
  await ctrl.tick() // sequence=1; ACK held back across Reconnecting
  assert.ok(heldFeedback)
  ctrl.setRtcReconnecting(true)
  receiver.paused = true
  ctrl.acceptFeedback('vehicle-car-e2e', true, receiver.readyFeedback(state.controlSession.session_id))
  assert.equal(ctrl.state, 'ready')

  ctrl.setRtcReconnecting(false)
  // Deliver pre-reconnect Reliable ACK right after Reconnected: must NOT fail with unexpected_ack!
  ctrl.acceptFeedback('vehicle-car-e2e', true, heldFeedback)
  assert.equal(ctrl.state, 'ready')
  await ctrl.tick()
  assert.deepEqual(receiver.lastCommand, { steering: 0, throttle: 0, brake: 0, direction: 0 })

  // L3 Global Space E-Stop via single bindKeyboardInput listener (no keyboard driving enabled)
  const controls = new ControlInput({
    allowVehicleActions: false,
    send: async intent => {
      const cmd = toV2ControlCommand(intent)
      ctrl.setCommand(cmd)
      await ctrl.tick()
    },
    onChange: () => {},
    onError: err => { throw err },
  })
  controls.setAvailable(true)
  const listeners = new Map()
  const win = {
    addEventListener: (k, fn) => listeners.set(k, [...(listeners.get(k) ?? []), fn]),
    removeEventListener: (k, fn) => listeners.set(k, (listeners.get(k) ?? []).filter(f => f !== fn)),
  }
  const doc = {
    hidden: false,
    hasFocus: () => true,
    addEventListener: () => {},
    removeEventListener: () => {},
  }
  const unbind = bindKeyboardInput(controls, win, doc, undefined, undefined, undefined, () => controls.emergencyStop())
  try {
    for (const fn of listeners.get('keydown') ?? []) {
      fn({ code: 'Space', repeat: false, altKey: false, ctrlKey: false, metaKey: false, isComposing: false, target: doc, preventDefault() {} })
    }
    await new Promise(resolve => setTimeout(resolve, 20))
    assert.deepEqual(receiver.lastCommand, { steering: 0, throttle: 0, brake: 100, direction: 0 })
    assert.equal(ctrl.isEmergencyStop, true)
    assert.equal(ctrl.timingPolicy.mediaPauseGraceMs, 5000)
    // Simulate >5s media loss -> fail locks session -> auto-release completes handover to closed
    controls.setAvailable(false)
    ctrl.setMediaReady(false)
    assert.equal(ctrl.state, 'locked')
    await ctrl.release()
    assert.equal(ctrl.state, 'closed')
    assert.equal(state.handoverConfirmed, true)
  } finally {
    unbind()
    await ctrl.release()
    await lifecycle.stop()
  }
})
