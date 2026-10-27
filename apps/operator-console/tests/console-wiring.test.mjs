import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

test('console wires topics, vehicle destination, monitoring and reconnect control release', async () => {
    const elements = new Map();
    const element = id => {
        if (!elements.has(id)) elements.set(id, {
            value: id === 'target-vehicle' ? 'car-1' : '',
            style: {}, disabled: false, textContent: '', innerHTML: '',
        });
        return elements.get(id);
    };
    const rooms = [], senders = [], monitors = [], intervals = new Map();
    let intervalId = 0;
    class Room {
        constructor() {
            this.handlers = new Map();
            this.sent = [];
            this.localParticipant = {publishData: async (bytes, options) => this.sent.push({bytes, options})};
            rooms.push(this);
        }
        on(name, callback) { this.handlers.set(name, callback); }
        async connect() {}
        disconnect() {}
    }
    class Sender {
        commands = [];
        released = false;
        constructor() { senders.push(this); }
        async createKeyPair() {}
        async acquireSession() { return {token: 'test-room-token'}; }
        setPublishData(publish) { this.publish = publish; }
        startRenewal() {}
        async release() { this.released = true; }
        async sendCommand(command) { this.commands.push(command); await this.publish(JSON.stringify(command)); }
    }
    class Monitor {
        received = [];
        closed = false;
        constructor() { monitors.push(this); }
        receive(...args) { this.received.push(args); }
        close() { this.closed = true; }
    }
    const handlers = new Map();
    const context = vm.createContext({
        URLSearchParams, TextEncoder, console, setTimeout, clearTimeout,
        setInterval: callback => { intervals.set(++intervalId, callback); return intervalId; },
        clearInterval: id => intervals.delete(id),
        document: {getElementById: element, querySelectorAll: () => []},
        window: {
            location: {search: '?dev=1', origin: 'http://console', pathname: '/'},
            addEventListener: (name, callback) => handlers.set(name, callback),
        },
        SecureControlSender: Sender, VehicleStateMonitor: Monitor,
        createVideoGrid: () => ({clear() {}, subscribe() {}, unsubscribe() {}}),
        LivekitClient: {Room, RoomEvent: {
            Disconnected: 'disconnected', Reconnecting: 'reconnecting', Reconnected: 'reconnected',
            TrackSubscribed: 'trackSubscribed', TrackUnsubscribed: 'trackUnsubscribed',
            DataReceived: 'dataReceived',
        }},
        alert: message => { throw new Error(message); },
    });
    const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
    const script = html.match(/<script type="module">([\s\S]*?)<\/script>/)[1]
        .replace(/^\s*import .+ from .+;$/gm, '');
    vm.runInContext(script, context);
    vm.runInContext("accessToken = 'test-token'", context);
    await context.window.startTeleop();
    const room = rooms[0], sender = senders[0], monitor = monitors[0];
    await context.window.sendHighLevel('left');
    assert.equal(room.sent[0].options.topic, 'vehicle.control');
    assert.equal(room.sent[0].options.reliable, false);
    assert.deepEqual(Array.from(room.sent[0].options.destinationIdentities), ['vehicle-car-1']);
    const bytes = new TextEncoder().encode('{}'), vehicle = {identity: 'vehicle-car-1'};
    room.handlers.get('dataReceived')(bytes, vehicle, 1, 'vehicle.state');
    assert.equal(monitor.received[0][0], bytes);
    assert.equal(monitor.received[0][2], 'vehicle.state');
    context.window.beginHighLevel('forward');
    context.window.beginHighLevel('emergency_stop');
    assert.equal(intervals.size, 1);
    for (const callback of intervals.values()) callback();
    assert.equal(sender.commands.at(-1).action, 'emergency_stop');
    room.handlers.get('reconnecting')();
    assert.equal(sender.released, true);
    assert.equal(intervals.size, 0);
    room.handlers.get('reconnected')();
    assert.match(element('hud').textContent, /reacquire control/);
    await context.window.stopTeleop();
    assert.equal(monitor.closed, true);
});
