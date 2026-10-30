import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import {ControlInput, bindKeyboardInput} from '../dist/lib/control-input.js';
import {GamepadInput, bindGamepadInput} from '../dist/lib/gamepad-input.js';

test('console wires topics, vehicle destination, monitoring and reconnect control release', async t => {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, {
            value: id === 'target-vehicle' ? 'car-1' : id === 'input-device' ? 'gamepad' : '',
            style: {}, disabled: false, textContent: '', innerHTML: '',
            handlers: new Map(),
            addEventListener(name, callback) { this.handlers.set(name, callback); },
            blur() {}, replaceChildren() {}, add() {},
        });
        return elements.get(id);
    };
    const rooms = [], senders = [], monitors = [], requests = [], intervals = new Map();
    let rejectAcquire = false;
    const alerts = [];
    const panels = ['pointer', 'keyboard', 'gamepad'].map(inputPanel => ({dataset: {inputPanel}, hidden: inputPanel !== 'gamepad'}));
    let intervalId = 0;
    t.mock.method(globalThis, 'setInterval', (callback, delay) => {
        intervals.set(++intervalId, {callback, delay}); return intervalId;
    });
    t.mock.method(globalThis, 'clearInterval', id => intervals.delete(id));
    class Room {
        constructor(options) {
            assert.equal(options.adaptiveStream, false);
            this.handlers = new Map();
            this.remoteParticipants = new Map();
            this.sent = [];
            this.localParticipant = {publishData: async (bytes, options) => this.sent.push({bytes, options})};
            rooms.push(this);
        }
        on(name, callback) { this.handlers.set(name, callback); }
        async connect(url, token, options) { assert.equal(options.autoSubscribe, true); }
        disconnect() {}
    }
    class Sender {
        commands = [];
        released = false;
        constructor() { senders.push(this); }
        async createKeyPair() {}
        async acquireSession() {
            if (rejectAcquire) throw new Error('control conflict');
            return {token: 'test-room-token'};
        }
        setPublishData(publish) { this.publish = publish; }
        startRenewal() {}
        async release() { this.released = true; }
        async sendCommand(command) { this.commands.push(command); await this.publish(JSON.stringify(command)); }
    }
    class Monitor {
        received = [];
        closed = false;
        constructor(element, id, onGear) { this.onGear = onGear; monitors.push(this); }
        receive(...args) { this.received.push(args); }
        noteVehiclePresent(present) { this.vehiclePresent = present; }
        close() { this.closed = true; }
    }
    const views = [], gears = [], videos = [];
    const handlers = new Map();
    const context = vm.createContext({
        URLSearchParams, TextEncoder, console: {info() {}, error() {}, warn() {}}, setTimeout, clearTimeout,
        fetch: async url => { requests.push(url); return {ok: true, json: async () => ({token: 'observer-token'})}; },
        setInterval: callback => { intervals.set(++intervalId, callback); return intervalId; },
        clearInterval: id => intervals.delete(id),
        document: {getElementById: element, querySelectorAll: selector => selector === '[data-input-panel]' ? panels : [],
            addEventListener() {}, hasFocus: () => true, hidden: false},
        navigator: {getGamepads: () => []}, Option: class {},
        ControlInput, bindKeyboardInput, GamepadInput, bindGamepadInput,
        window: {
            location: {search: '?dev=1&access=controller', origin: 'http://console', pathname: '/'},
            addEventListener: (name, callback) => handlers.set(name, callback),
        },
        SecureControlSender: Sender, VehicleStateMonitor: Monitor,
        createVideoGrid: () => ({clear() {}, subscribe(track) { videos.push(track); }, unsubscribe() {},
            noteCommand(command) { views.push(command.action); }, noteGear(gear) { gears.push(gear); }}),
        LivekitClient: {Room, RoomEvent: {
            Disconnected: 'disconnected', Reconnecting: 'reconnecting', Reconnected: 'reconnected',
            TrackSubscribed: 'trackSubscribed', TrackUnsubscribed: 'trackUnsubscribed',
            DataReceived: 'dataReceived',
            ParticipantConnected: 'participantConnected', ParticipantDisconnected: 'participantDisconnected',
        }},
        alert: message => alerts.push(message),
    });
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import .+ from .+;$/gm, '');
    vm.runInContext(script, context);
    vm.runInContext("accessToken = 'test-token'", context);
    await context.window.startTeleop('controller');
    assert.equal(senders.length, 0, 'control requires an existing monitoring connection');
    await context.window.startTeleop();
    assert.equal(senders.length, 0, 'default connection is observer even with legacy controller URL');
    assert.match(requests[0], /access=observer/);
    assert.equal(element('acquire-control').disabled, false);
    assert.equal(element('target-vehicle').disabled, true);
    assert.equal(element('driving-controls').hidden, true);
    await Promise.all([context.window.startTeleop('controller'), context.window.startTeleop('controller')]);
    assert.equal(senders.length, 1, 'duplicate acquisition is ignored while connecting');
    assert.equal(monitors[0].closed, true);
    assert.equal(element('driving-controls').hidden, false);
    assert.equal(element('release-control').disabled, false);
    assert.equal(element('keyboard-enabled').checked, false);
    assert.match(element('hud').textContent, /已取得控制权/);
    const room = rooms[1], sender = senders[0], monitor = monitors[1];
    assert.equal(monitor.vehiclePresent, false);
    room.remoteParticipants.set('vehicle', {identity: 'vehicle-car-1'});
    room.handlers.get('participantConnected')();
    assert.equal(monitor.vehiclePresent, true);
    room.remoteParticipants.delete('vehicle');
    room.handlers.get('participantDisconnected')();
    assert.equal(monitor.vehiclePresent, false);
    vm.runInContext("controlInput.setKeyboardEnabled(true)", context);
    await new Promise(resolve => setImmediate(resolve));
    vm.runInContext("controlInput.keyDown('KeyA')", context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sender.commands.at(-1).action, 'left');
    vm.runInContext("controlInput.keyUp('KeyA'); controlInput.keyDown('KeyS')", context);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(views.at(-1), 'reverse');
    monitor.onGear('GEAR_REVERSE');
    assert.equal(gears.at(-1), 'GEAR_REVERSE');
    const video = {kind: 'video'};
    room.handlers.get('trackSubscribed')(video, {}, {identity: 'other'});
    assert.equal(videos.length, 0);
    room.handlers.get('trackSubscribed')(video, {}, {identity: 'vehicle-car-1'});
    assert.equal(videos[0], video);
    assert.equal(room.sent[0].options.topic, 'vehicle.control');
    assert.equal(room.sent[0].options.reliable, false);
    assert.deepEqual(Array.from(room.sent[0].options.destinationIdentities), ['vehicle-car-1']);
    const bytes = new TextEncoder().encode('{}'), vehicle = {identity: 'vehicle-car-1'};
    room.handlers.get('dataReceived')(bytes, vehicle, 1, 'vehicle.state');
    assert.equal(monitor.received[0][0], bytes);
    assert.equal(monitor.received[0][2], 'vehicle.state');
    const pointer = {button: 0, pointerId: 1, preventDefault() {},
        currentTarget: {setPointerCapture() {}}};
    context.window.beginHighLevel('forward', pointer);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sender.commands.at(-1).action, 'forward');
    context.window.emergencyStop();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sender.commands.at(-1).action, 'emergency_stop');
    assert.equal([...intervals.values()].filter(timer => timer.delay === 100).length, 0);
    context.window.requestVehicleAction('auto_enter');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sender.commands.at(-1).action, 'auto_enter');
    assert.match(element('vehicle-action-status').textContent, /进入自动驾驶.*底盘/);
    context.window.requestVehicleAction('gear_neutral');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sender.commands.at(-1).action, 'gear_neutral');
    vm.runInContext("controlInput.setKeyboardEnabled(true); controlInput.keyDown('KeyW')", context);
    element('input-device').value = 'pointer';
    element('input-device').handlers.get('change')({target: element('input-device')});
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sender.commands.at(-1).action, 'stop');
    assert.equal(element('keyboard-enabled').checked, false);
    assert.deepEqual(panels.map(panel => panel.hidden), [false, true, true]);
    context.window.beginHighLevel('forward', pointer);
    await new Promise(resolve => setImmediate(resolve));
    room.handlers.get('reconnecting')();
    assert.equal(sender.released, true);
    assert.equal([...intervals.values()].filter(timer => timer.delay === 100).length, 0);
    assert.equal(element('keyboard-enabled').disabled, true);
    assert.equal(element('gamepad-enabled').disabled, true);
    assert.equal(element('acquire-control').disabled, true);
    room.handlers.get('reconnected')();
    assert.match(element('hud').textContent, /重新申请控制权/);
    assert.equal(element('acquire-control').disabled, false);
    const count = sender.commands.length;
    vm.runInContext("controlInput.setKeyboardEnabled(true); controlInput.keyDown('KeyW')", context);
    context.window.requestVehicleAction('auto_enter');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(sender.commands.length, count);
    await context.window.startTeleop('controller');
    const secondSender = senders[1];
    assert.equal(element('keyboard-enabled').checked, false);
    await context.window.startTeleop('observer');
    assert.equal(secondSender.released, true);
    assert.equal(element('driving-controls').hidden, true);
    assert.equal(element('keyboard-enabled').disabled, true);
    assert.equal(element('gamepad-enabled').disabled, true);
    assert.equal(senders.length, 2, 'release returns to observer without creating a sender');
    rejectAcquire = true;
    await context.window.startTeleop('controller');
    assert.equal(senders[2].released, true, 'failed acquisition cleans up the sender');
    assert.equal(element('driving-controls').hidden, true);
    assert.equal(element('acquire-control').disabled, true);
    assert.equal(element('connect-btn').disabled, false);
    assert.equal(element('target-vehicle').disabled, false);
    assert.match(alerts.at(-1), /control conflict/);
    await context.window.stopTeleop();
    assert.equal(monitor.closed, true);
});
