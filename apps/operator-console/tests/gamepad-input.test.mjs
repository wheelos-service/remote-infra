import test from 'node:test';
import assert from 'node:assert/strict';
import {ControlInput, bindKeyboardInput} from '../dist/lib/control-input.js';
import {GamepadInput, bindGamepadInput, defaultGamepadMapping, validateMapping, analogAxis} from '../dist/lib/gamepad-input.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const pad = (index = 0) => ({
    index, id: `Wireless Controller ${index}`, mapping: 'standard', connected: true,
    axes: [0, 0, 0, 0], buttons: Array.from({length: 16}, () => ({pressed: false, touched: false, value: 0})),
});

function setup(t, send) {
    const sent = [], states = [], timers = new Map();
    let view, now = 0, id = 0;
    const originals = {set: globalThis.setInterval, clear: globalThis.clearInterval,
        performance: Object.getOwnPropertyDescriptor(globalThis, 'performance')};
    globalThis.setInterval = (callback, delay) => { timers.set(++id, {callback, delay}); return id; };
    globalThis.clearInterval = key => timers.delete(key);
    Object.defineProperty(globalThis, 'performance', {value: {now: () => now}, configurable: true});
    const input = new ControlInput({send: async command => { sent.push(command); await send?.(command); },
        onChange: state => states.push(state), onError: error => { throw error; }});
    const monitor = new GamepadInput(input, state => { view = state; });
    const device = pad();
    t.after(() => {
        input.setAvailable(false);
        globalThis.setInterval = originals.set;
        globalThis.clearInterval = originals.clear;
        if (originals.performance) Object.defineProperty(globalThis, 'performance', originals.performance);
        else delete globalThis.performance;
    });
    return {
        input, monitor, device, sent, states, timers,
        get view() { return view; },
        actions: () => sent.map(command => command.action ?? (command.throttle > 0
            ? command.direction < 0 ? 'reverse' : 'forward'
            : command.steering < 0 ? 'left' : command.steering > 0 ? 'right' : 'stop')),
        poll: (foreground = true) => monitor.poll([device], foreground),
        button(index, pressed) { device.buttons[index] = {pressed, value: pressed ? 1 : 0, touched: pressed}; },
        tick(delay = 100) { [...timers.values()].filter(timer => timer.delay === delay).forEach(timer => timer.callback()); },
        advance(ms) { now += ms; },
        async arm() {
            input.setAvailable(true);
            monitor.poll([device], true);
            monitor.confirmMapping(true);
            monitor.setEnabled(true);
            monitor.poll([device], true);
            await settle();
            sent.length = 0;
        },
    };
}

test('inspection is read-only and exposes device, axes, button values and mapping', async t => {
    const h = setup(t);
    h.device.mapping = '';
    h.device.axes[0] = -0.8;
    h.button(4, true);
    h.poll();
    assert.equal(h.view.pad.id, h.device.id);
    assert.equal(h.view.pad.mapping, '');
    assert.equal(h.view.pad.axes[0], -0.8);
    assert.equal(h.view.pad.buttons[4].value, 1);
    h.monitor.setEnabled(true);
    h.poll();
    await settle();
    assert.deepEqual(h.actions(), []);
    assert.equal(h.input.isGamepadEnabled, false);
});

test('mapping rejects out-of-range, repeated and missing direction controls', () => {
    const device = pad();
    assert.equal(validateMapping(defaultGamepadMapping, device), '');
    for (const change of [
        {axisX: 4}, {enableButton: 20}, {emergencyButton: 4}, {leftButton: 4},
        {axisX: 0.5}, {upButton: NaN}, {axisY: 0},
        {axisX: -1, axisY: -1, upButton: -1, downButton: -1, leftButton: -1, rightButton: -1},
    ]) assert.ok(validateMapping({...defaultGamepadMapping, ...change}, device));
});

test('confirmation plus controller access is required to enable', async t => {
    const h = setup(t);
    h.poll();
    h.monitor.confirmMapping(true);
    h.monitor.setEnabled(true);
    assert.equal(h.input.isGamepadEnabled, false);
    h.input.setAvailable(true);
    h.monitor.confirmMapping(false);
    h.monitor.setEnabled(true);
    assert.equal(h.input.isGamepadEnabled, false);
    h.monitor.confirmMapping(true);
    h.monitor.setEnabled(true);
    assert.equal(h.input.isGamepadEnabled, true);
    await settle();
});

test('arming while enable is held or stick is displaced cannot start motion', async t => {
    const h = setup(t);
    h.button(4, true);
    h.device.axes[3] = -1;
    await h.arm();
    h.poll();
    await settle();
    assert.deepEqual(h.actions(), []);
    h.button(4, false);
    h.device.axes[3] = 0;
    h.poll();
    h.button(4, true);
    h.device.axes[3] = -1;
    h.poll();
    await settle();
    assert.deepEqual(h.actions(), ['forward']);
});

test('all stick directions require held enable and share the 100ms scheduler', async t => {
    const h = setup(t);
    await h.arm();
    for (const [x, y, action] of [[0, -1, 'forward'], [0, 1, 'reverse'], [-1, 0, 'left'], [1, 0, 'right']]) {
        h.device.axes = [x, 0, 0, y];
        h.poll();
        await settle();
        assert.deepEqual(h.actions(), []);
        h.device.axes = [0, 0, 0, 0];
        h.poll();
        h.button(4, true);
        h.device.axes = [x, 0, 0, y];
        h.poll();
        await settle();
        assert.deepEqual(h.actions(), [action]);
        h.poll();
        await settle();
        assert.deepEqual(h.actions(), [action]);
        h.tick();
        await settle();
        assert.deepEqual(h.actions(), [action, action]);
        h.device.axes = [0, 0, 0, 0];
        h.button(4, false);
        h.poll();
        await settle();
        assert.equal(h.actions().at(-1), 'stop');
        assert.equal(h.timers.size, 0);
        h.sent.length = 0;
    }
});

test('releasing enable stops and requires centering before re-engaging', async t => {
    const h = setup(t);
    await h.arm();
    h.button(4, true);
    h.device.axes[3] = -1;
    h.poll();
    await settle();
    h.button(4, false);
    h.poll();
    await settle();
    h.button(4, true);
    h.poll();
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'stop']);
    assert.equal(h.timers.size, 0);
});

test('deadzone and latest analog magnitudes are sent on the shared timer', async t => {
    const h = setup(t); await h.arm(); h.button(4, true);
    h.device.axes = [.15, 0, 0, 0]; h.poll(); await settle(); assert.deepEqual(h.sent, []);
    h.device.axes = [.575, 0, 0, -.575]; h.poll(); await settle();
    const first = h.sent.at(-1);
    assert.equal(first.mode, 'low_level');
    assert.ok(Math.abs(first.steering - .5) < 1e-12);
    assert.ok(Math.abs(first.throttle - .5) < 1e-12);
    h.device.axes = [.32, 0, 0, -.32]; h.poll(); await settle();
    assert.equal(h.sent.length, 1);
    h.tick(); await settle();
    assert.ok(Math.abs(h.sent.at(-1).throttle - .2) < 1e-12);
    assert.ok(Math.abs(h.sent.at(-1).steering - .2) < 1e-12);
    h.device.axes = [0, 0, 0, 0]; h.poll(); await settle();
    assert.equal(h.sent.at(-1).action, 'stop'); assert.equal(h.timers.size, 0);
});

test('diagonal driving is proportional while opposing d-pad inputs stop', async t => {
    const h = setup(t); await h.arm(); h.button(4,true);
    h.device.axes = [1, 0, 0, -1]; h.poll(); await settle();
    assert.deepEqual(h.sent.at(-1), {mode:'low_level',steering:1,throttle:1,brake:0,direction:1});
    h.button(12,true); h.button(13,true); h.poll(); await settle();
    assert.equal(h.sent.at(-1).action, 'stop');
    h.button(13,false); h.poll(); h.tick(); await settle();
    assert.equal(h.sent.at(-1).action, 'stop');
});

test('reversing requires release and neutral; steering-only keeps gear and requests normal braking', async t => {
    const h = setup(t); await h.arm(); h.button(4,true);
    h.device.axes = [0, 0, 0, -1]; h.poll(); await settle();
    h.device.axes = [0, 0, 0, 1]; h.poll(); await settle();
    assert.equal(h.sent.at(-1).action,'stop');
    h.button(4,false); h.device.axes = [0, 0, 0, 0]; h.poll();
    h.button(4,true); h.device.axes = [-.575, 0, 0, 0]; h.poll(); await settle();
    assert.equal(h.sent.at(-1).direction,0); assert.equal(h.sent.at(-1).throttle,0);
    assert.equal(h.sent.at(-1).brake,1);
    h.device.axes = [0, 0, 0, 1]; h.poll(); h.tick(); await settle();
    assert.equal(h.sent.at(-1).direction,-1);
});

test('deadzone spans the remaining full travel linearly', () => {
    assert.equal(analogAxis(.15),0); assert.equal(analogAxis(-.1),0);
    assert.equal(analogAxis(1),1); assert.equal(analogAxis(-1),-1);
    assert.ok(Math.abs(analogAxis(.575)-.5)<1e-12);
});

test('emergency overrides enabled motion and requires explicit re-enable', async t => {
    const h = setup(t);
    await h.arm();
    h.button(4, true);
    h.device.axes = [0, 0, 0, -1];
    h.poll();
    await settle();
    h.button(1, true);
    h.poll();
    await settle();
    h.button(1, false);
    h.poll();
    h.tick();
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'emergency_stop']);
    assert.equal(h.input.isGamepadEnabled, false);
    assert.equal(h.timers.size, 0);
});

test('webpage emergency also prevents the next poll from resuming held motion', async t => {
    const h = setup(t);
    await h.arm();
    h.button(4, true);
    h.device.axes = [0, 0, 0, -1];
    h.poll();
    await settle();
    h.input.emergencyStop();
    h.poll();
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'emergency_stop']);
    assert.equal(h.input.isGamepadEnabled, false);
});

test('disconnect stops, clears confirmation and never takes over another controller', async t => {
    const h = setup(t);
    await h.arm();
    h.button(4, true);
    h.device.axes[3] = -1;
    h.poll();
    await settle();
    h.monitor.poll([null, pad(1)], true);
    await settle();
    h.monitor.poll([null, pad(1)], true);
    assert.deepEqual(h.actions(), ['forward', 'stop']);
    assert.equal(h.view.pad, null);
    assert.equal(h.view.confirmed, false);
    h.poll();
    assert.equal(h.input.isGamepadEnabled, false);
    assert.equal(h.view.confirmed, false);
});

test('foreground loss and restoration do not resume held motion', async t => {
    const h = setup(t);
    await h.arm();
    h.button(4, true);
    h.device.axes[3] = -1;
    h.poll();
    await settle();
    h.poll(false);
    await settle();
    h.poll(true);
    h.tick();
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'stop']);
    assert.equal(h.input.isGamepadEnabled, false);
});

test('sample stalls stop the repeating scheduler even before the browser polls again', async t => {
    const h = setup(t);
    await h.arm();
    h.button(4, true);
    h.device.axes[3] = -1;
    h.poll();
    await settle();
    h.advance(201);
    h.tick();
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'stop']);
    assert.equal(h.input.isGamepadEnabled, false);
    assert.equal(h.timers.size, 0);
});

test('mapping edits stop immediately and invalidate confirmation', async t => {
    const h = setup(t);
    await h.arm();
    h.button(4, true);
    h.device.axes[3] = -1;
    h.poll();
    await settle();
    h.monitor.setMapping({...defaultGamepadMapping, invertY: true});
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'stop']);
    assert.equal(h.view.confirmed, false);
    assert.equal(h.input.isGamepadEnabled, false);
});

test('custom axis inversion and button-only mapping are honored', async t => {
    const h = setup(t);
    h.input.setAvailable(true);
    h.poll();
    h.monitor.setMapping({...defaultGamepadMapping, invertY: true});
    h.monitor.confirmMapping(true);
    h.monitor.setEnabled(true);
    h.poll();
    await settle();
    h.sent.length = 0;
    h.button(4, true);
    h.device.axes[3] = 1;
    h.poll();
    await settle();
    assert.deepEqual(h.actions(), ['forward']);
    h.monitor.setMapping({...defaultGamepadMapping, axisX: -1, axisY: -1});
    h.device.axes = [0, 0, 0, 0];
    h.button(4, false);
    h.monitor.confirmMapping(true);
    h.monitor.setEnabled(true);
    h.poll();
    await settle();
    h.sent.length = 0;
    h.button(4, true);
    h.button(14, true);
    h.poll();
    await settle();
    assert.deepEqual(h.actions(), ['left']);
});

test('keyboard and pointer take ownership without concurrent gamepad movement', async t => {
    const h = setup(t);
    await h.arm();
    h.button(4, true);
    h.device.axes[3] = -1;
    h.poll();
    await settle();
    h.input.setKeyboardEnabled(true);
    await settle();
    h.poll();
    h.input.keyDown('KeyA');
    await settle();
    assert.equal(h.input.isGamepadEnabled, false);
    assert.equal(h.input.isKeyboardEnabled, true);
    assert.deepEqual(h.actions(), ['forward', 'stop', 'left']);
    assert.equal(h.timers.size, 1);
    h.input.beginPointer({mode: 'high_level', action: 'right'});
    h.poll();
    await settle();
    assert.equal(h.input.isKeyboardEnabled, false);
    assert.equal(h.input.isGamepadEnabled, false);
    assert.equal(h.timers.size, 1);
    assert.equal(h.actions().at(-1), 'right');
});

class Events {
    listeners = new Map(); hidden = false; activeElement = null;
    hasFocus() { return true; }
    addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]); }
    removeEventListener(name, callback) { this.listeners.set(name, this.listeners.get(name)?.filter(item => item !== callback)); }
    emit(name, props = {}) { this.listeners.get(name)?.forEach(callback => callback({target: this, ...props})); }
}

test('browser disconnect event and blur immediately stop; cleanup removes polling', async t => {
    const h = setup(t), win = new Events(), doc = new Events();
    bindKeyboardInput(h.input, win, doc);
    let pads = [h.device];
    const cleanup = bindGamepadInput(h.monitor, win, doc, {getGamepads: () => pads});
    await h.arm();
    h.button(4, true);
    h.device.axes[3] = -1;
    h.tick(50);
    await settle();
    win.emit('blur');
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'stop']);
    assert.equal(h.input.isGamepadEnabled, false);
    h.device.axes[3] = 0;
    h.button(4, false);
    await h.arm();
    h.button(4, true);
    h.device.axes[3] = -1;
    h.tick(50);
    await settle();
    pads = [];
    win.emit('gamepaddisconnected', {gamepad: h.device});
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'stop']);
    assert.equal(h.view.confirmed, false);
    cleanup();
    assert.equal(h.timers.size, 0);
});

test('missing or denied browser API remains read-only and disarms controls', async t => {
    const h = setup(t), win = new Events(), doc = new Events();
    await h.arm();
    const cleanup = bindGamepadInput(h.monitor, win, doc, {});
    assert.equal(h.input.isGamepadEnabled, false);
    assert.match(h.view.message, /HTTPS/);
    cleanup();
    const cleanupDenied = bindGamepadInput(h.monitor, win, doc, {getGamepads: () => { throw new Error('denied'); }});
    assert.match(h.view.message, /权限/);
    cleanupDenied();
});

test('a replacement at the same device index cannot inherit confirmation or control', async t => {
    const h = setup(t);
    await h.arm();
    h.button(4, true);
    h.device.axes[3] = -1;
    h.poll();
    await settle();
    h.device.id = 'Replacement controller';
    h.poll();
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'stop']);
    assert.equal(h.view.confirmed, false);
    assert.equal(h.input.isGamepadEnabled, false);
});

test('invalid samples stop motion instead of preserving the previous direction', async t => {
    const h = setup(t);
    await h.arm();
    h.button(4, true);
    h.device.axes[3] = -1;
    h.poll();
    await settle();
    h.device.axes[0] = NaN;
    h.poll();
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'stop']);
    assert.equal(h.input.isGamepadEnabled, false);
});

test('RTC availability loss prevents held controller input from resuming after recovery', async t => {
    const h = setup(t);
    await h.arm();
    h.button(4, true);
    h.device.axes[3] = -1;
    h.poll();
    await settle();
    h.input.setAvailable(false);
    h.poll();
    h.input.setAvailable(true);
    h.poll();
    h.tick();
    await settle();
    assert.deepEqual(h.actions(), ['forward']);
    assert.equal(h.input.isGamepadEnabled, false);
    assert.equal(h.timers.size, 0);
});

test('emergency requires no held enable button once gamepad control is armed', async t => {
    const h = setup(t);
    await h.arm();
    h.button(1, true);
    h.poll();
    await settle();
    assert.deepEqual(h.actions(), ['emergency_stop']);
    assert.equal(h.input.isGamepadEnabled, false);
});


test('releasing enable replaces all queued analog changes with stop while publication is blocked', async t => {
    let release, blocked = false;
    const h = setup(t, command => {
        if (command.mode === 'low_level' && !blocked) {
            blocked = true;
            return new Promise(resolve => { release = resolve; });
        }
    });
    await h.arm(); h.button(4,true); h.device.axes = [.3, 0, 0, -.6]; h.poll();
    h.device.axes = [.8, 0, 0, -.9]; h.poll(); h.tick();
    h.device.axes = [.2, 0, 0, -.3]; h.poll();
    h.button(4,false); h.poll(); release(); await settle();
    assert.equal(h.sent.length,2);
    assert.equal(h.sent[0].mode,'low_level');
    assert.equal(h.sent[1].action,'stop');
    assert.equal(h.timers.size,0);
});


test('left horizontal plus right vertical combine in forward and reverse without stopping propulsion', async t => {
    const h = setup(t);
    assert.equal(defaultGamepadMapping.axisX, 0);
    assert.equal(defaultGamepadMapping.axisY, 3);
    for (const [rightY, direction] of [[-.575, 1], [.575, -1]]) {
        h.button(4,false); h.device.axes = [0,0,0,0]; await h.arm();
        h.button(4,true); h.device.axes = [0,0,0,rightY]; h.poll(); await settle();
        assert.ok(Math.abs(h.sent.at(-1).throttle - .5) < 1e-12);
        for (const leftX of [-.575, .575]) {
            h.device.axes[0] = leftX; h.poll(); h.tick(); await settle();
            const command = h.sent.at(-1);
            assert.equal(command.mode, 'low_level');
            assert.ok(Math.abs(command.steering - Math.sign(leftX)*.5) < 1e-12);
            assert.ok(Math.abs(command.throttle - .5) < 1e-12);
            assert.equal(command.brake, 0);
            assert.equal(command.direction, direction);
            assert.equal(h.input.isGamepadEnabled, true);
            assert.equal(h.timers.size, 1);
        }
        h.device.axes[0] = 0; h.poll(); h.tick(); await settle();
        assert.equal(h.sent.at(-1).steering, 0);
        assert.ok(h.sent.at(-1).throttle > 0);
    }
});

test('left vertical and right horizontal axes do not drive or steer', async t => {
    const h = setup(t); await h.arm(); h.button(4,true);
    h.device.axes = [0,-1,1,0]; h.poll(); h.tick(); await settle();
    assert.deepEqual(h.sent, []);
});
