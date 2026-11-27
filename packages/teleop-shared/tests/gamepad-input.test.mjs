import test from 'node:test';
import assert from 'node:assert/strict';
import {ControlInput, bindKeyboardInput} from '../dist/control-input.js';
import {TELEOP_TIMING} from '../dist/control-timing.js';
import {GamepadInput, bindGamepadInput, defaultGamepadMapping, validateMapping, analogAxis} from '../dist/gamepad-input.js';

const settle = () => new Promise(resolve => setImmediate(resolve));
const pad = (index = 0) => ({
    index, id: `Wireless Controller ${index}`, mapping: 'standard', connected: true,
    axes: [0, 0, 0, 0], buttons: Array.from({length: 16}, () => ({pressed: false, touched: false, value: 0})),
});

function setup(t, send, direction = () => 1, supportsDriving = () => true, triggers = {}) {
    const sent = [], states = [], timers = new Map();
    let view, now = 0, id = 0;
    const originals = {set: globalThis.setInterval, clear: globalThis.clearInterval,
        performance: Object.getOwnPropertyDescriptor(globalThis, 'performance')};
    globalThis.setInterval = (callback, delay) => { timers.set(++id, {callback, delay}); return id; };
    globalThis.clearInterval = key => timers.delete(key);
    Object.defineProperty(globalThis, 'performance', {value: {now: () => now}, configurable: true});
    const input = new ControlInput({send: async command => { sent.push(command); await send?.(command); },
        onChange: state => states.push(state), onError: error => { throw error; }});
    const monitor = new GamepadInput(input, state => { view = state; }, direction, supportsDriving, triggers);
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
            : command.brake > 0 ? 'brake' : command.steering < 0 ? 'left' : command.steering > 0 ? 'right' : 'stop')),
        poll: (foreground = true) => monitor.poll([device], foreground),
        button(index, pressed) { device.buttons[index] = {pressed, value: pressed ? 1 : 0, touched: pressed}; },
        tick(delay = TELEOP_TIMING.inputRepeatMs) { [...timers.values()].filter(timer => timer.delay === delay).forEach(timer => timer.callback()); },
        advance(ms) { now += ms; },
        async arm() {
            input.setAvailable(true);
            monitor.poll([device], true);
            monitor.confirmMapping(true);
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
    h.button(5, true);
    h.poll();
    assert.equal(h.view.pad.id, h.device.id);
    assert.equal(h.view.pad.mapping, '');
    assert.equal(h.view.pad.axes[0], -0.8);
    assert.equal(h.view.pad.buttons[5].value, 1);
    h.poll();
    await settle();
    assert.deepEqual(h.actions(), []);
    assert.equal(h.input.isGamepadEnabled, false);
});

test('vehicle buttons require neutral sticks and release between single requests', async t => {
    const h = setup(t);
    await h.arm();
    for (const [button, action] of [[0, 'gear_park'], [9, 'auto_enter'], [8, 'auto_exit']]) {
        h.button(button, true);
        h.poll();
        await settle();
        assert.equal(h.actions().at(-1), action);
        const count = h.sent.length;
        h.poll(); h.tick();
        await settle();
        assert.equal(h.sent.length, count);
        h.button(button, false);
        h.poll();
    }
});

test('unsupported receiver allows the independent emergency button only', async t => {
    const h = setup(t, undefined, () => 1, () => false);
    await h.arm();
    h.button(6, true); h.poll();
    h.button(6, false); h.device.axes[3] = 1; h.poll(); h.tick();
    await settle();
    assert.deepEqual(h.sent, []);
    h.button(1, true); h.poll(); await settle();
    assert.deepEqual(h.actions(), ['emergency_stop']);
});

test('LT cycles from fresh chassis feedback and retries the same target after a missed shift', async t => {
    let gear;
    const h = setup(t, undefined, undefined, undefined, {currentGear: () => gear});
    await h.arm();
    for (const [actual, expected] of [[undefined, undefined], ['P', 'gear_neutral'],
        ['N', 'gear_drive'], ['N', 'gear_drive'], ['D', 'gear_reverse'], ['R', 'gear_neutral']]) {
        gear = actual;
        h.button(6, true); h.poll(); await settle();
        assert.deepEqual(h.actions(), expected ? [expected] : []);
        h.poll();
        h.poll(); await settle();
        assert.deepEqual(h.actions(), expected ? [expected] : []);
        h.button(6, false); h.poll(); await settle();
        h.sent.length = 0;
    }
});

test('RT requests control once before a session, only after confirmation and a fresh foreground press', t => {
    let requests = 0;
    const h = setup(t, undefined, undefined, undefined, {toggleControl: () => requests++});
    h.monitor.setMapping({...defaultGamepadMapping, requestControlButton: 5});
    h.button(5, true); h.poll(); h.monitor.confirmMapping(true); h.poll();
    assert.equal(requests, 0);
    h.button(5, false); h.poll();
    h.button(5, true); h.poll(false); h.poll();
    assert.equal(requests, 0);
    h.button(5, false); h.button(7, true); h.poll();
    assert.equal(requests, 0);
    h.button(5, true); h.poll(); h.poll();
    assert.equal(requests, 1);
    assert.equal(h.input.isGamepadEnabled, false);
    assert.deepEqual(h.sent, []);
});

test('standard pad activates at neutral after takeover, RT toggles once per press even while driving', async t => {
    let remote = false, taps = 0;
    const h = setup(t, undefined, undefined, undefined, {
        standardMapping: defaultGamepadMapping, canDrive: () => remote, toggleControl: () => taps++,
    });
    h.button(7, true); h.poll();
    assert.equal(h.view.confirmed, true);
    assert.equal(taps, 0, 'plugging in with RT held must not request control');
    h.button(7, false); h.poll(); h.button(7, true); h.poll();
    h.input.setAvailable(true);
    remote = true;
    h.poll(); h.poll();
    assert.equal(taps, 1);
    assert.equal(h.input.isGamepadEnabled, false);
    h.device.axes[3] = -1; h.button(7, false); h.poll();
    assert.equal(h.input.isGamepadEnabled, false);
    h.device.axes.fill(0); h.poll();
    assert.equal(h.input.isGamepadEnabled, true);
    h.device.axes[3] = -1; h.poll();
    h.button(4, true); h.poll(); h.button(4, false); h.poll();
    await settle();
    assert.deepEqual(h.actions(), ['forward'], 'unmapped button presses leave stick input unchanged');
    h.button(7, true); h.poll(); h.poll(); await settle();
    assert.equal(taps, 2);
    assert.deepEqual(h.actions(), ['forward', 'stop']);
    assert.equal(h.timers.size, 0);
});

test('custom mappings and replacement pads require confirmation before automatic activation', t => {
    const h = setup(t, undefined, undefined, undefined, {standardMapping: defaultGamepadMapping});
    h.input.setAvailable(true);
    h.monitor.setMapping({...defaultGamepadMapping, invertY: true});
    h.poll();
    assert.equal(h.view.confirmed, false);
    assert.equal(h.input.isGamepadEnabled, false);
    h.monitor.confirmMapping(true); h.poll();
    assert.equal(h.input.isGamepadEnabled, true);
    h.device.id = 'Replacement pad';
    h.poll();
    assert.equal(h.view.confirmed, false);
    assert.equal(h.input.isGamepadEnabled, false);
});

test('vehicle buttons cannot switch while moving or with conflicting buttons', async t => {
    const h = setup(t);
    await h.arm();
    h.button(0, true); h.button(6, true); h.poll();
    await settle();
    assert.deepEqual(h.actions(), []);
    h.button(0, false); h.button(6, false); h.poll();
    h.device.axes[3] = -1; h.poll();
    await settle();
    assert.equal(h.actions().at(-1), 'forward');
    h.button(9, true); h.poll();
    await settle();
    assert.equal(h.actions().at(-1), 'stop');
    assert.equal(h.actions().includes('auto_enter'), false);
    assert.equal(h.timers.size, 0);
});

test('mapping rejects out-of-range, repeated and missing direction controls', () => {
    const device = pad();
    assert.equal(validateMapping(defaultGamepadMapping, device), '');
    assert.equal(validateMapping({...defaultGamepadMapping, leftButton: 4}, device), '');
    for (const change of [
        {axisX: 4}, {emergencyButton: 20}, {emergencyButton: 6}, {leftButton: 7}, {gearCycleButton: 7}, {requestControlButton: 13},
        {axisX: 0.5}, {upButton: NaN}, {axisY: 0}, {parkButton: 1}, {autoEnterButton: 16},
        {axisX: -1, axisY: -1, upButton: -1, downButton: -1, leftButton: -1, rightButton: -1},
    ]) assert.ok(validateMapping({...defaultGamepadMapping, ...change}, device));
});

test('confirmation plus controller access is required to enable', async t => {
    const h = setup(t);
    h.poll();
    h.monitor.confirmMapping(true);
    h.poll();
    assert.equal(h.input.isGamepadEnabled, false);
    h.input.setAvailable(true);
    h.monitor.confirmMapping(false);
    h.poll();
    assert.equal(h.input.isGamepadEnabled, false);
    h.monitor.confirmMapping(true);
    h.poll();
    assert.equal(h.input.isGamepadEnabled, true);
    await settle();
});

test('arming while a stick is displaced cannot start motion', async t => {
    const h = setup(t);
    h.device.axes[3] = -1;
    await h.arm();
    h.poll();
    await settle();
    assert.deepEqual(h.actions(), []);
    h.device.axes[3] = 0;
    h.poll();
    h.device.axes[3] = -1;
    h.poll();
    await settle();
    assert.deepEqual(h.actions(), ['forward']);
});

test('all stick directions work directly and share the 100ms scheduler', async t => {
    const h = setup(t);
    await h.arm();
    for (const [x, y, action] of [[0, -1, 'forward'], [0, 1, 'brake'], [-1, 0, 'left'], [1, 0, 'right']]) {
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
        h.poll();
        await settle();
        assert.equal(h.actions().at(-1), 'stop');
        assert.equal(h.timers.size, 0);
        h.sent.length = 0;
    }
});

test('deadzone and latest analog magnitudes are sent on the shared timer', async t => {
    const h = setup(t); await h.arm();
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
    const h = setup(t); await h.arm();
    h.device.axes = [1, 0, 0, -1]; h.poll(); await settle();
    assert.deepEqual(h.sent.at(-1), {mode:'low_level',steering:1,throttle:1,brake:0,direction:1});
    h.button(12,true); h.button(13,true); h.poll(); await settle();
    assert.equal(h.sent.at(-1).action, 'stop');
    h.button(13,false); h.poll(); h.tick(); await settle();
    assert.equal(h.sent.at(-1).action, 'stop');
});

test('direct throttle to service brake and steering in the longitudinal dead zone', async t => {
    const h = setup(t);
    await h.arm();

    for (const [y, throttle, brake] of [[-1, 1, 0], [1, 0, 1], [.575, 0, .5],
        [.149, 0, 0], [-.149, 0, 0], [-.575, .5, 0]]) {
        h.device.axes = [.575, 0, 0, y];
        h.poll(); h.tick(); await settle();
        const cmd = h.sent.at(-1);
        assert.ok(Math.abs(cmd.steering - .5) < 1e-12);
        assert.ok(Math.abs(cmd.throttle - throttle) < 1e-12);
        assert.ok(Math.abs(cmd.brake - brake) < 1e-12);
    }
});

test('D-pad requests full pedals in confirmed gear and still brakes in neutral', async t => {
    let direction = -1;
    const h = setup(t, undefined, () => direction);
    await h.arm();
    h.button(12, true);
    h.device.axes[3] = -.4;
    h.poll(); await settle();
    assert.deepEqual(h.sent.at(-1), {mode:'low_level', steering:0, throttle:1, brake:0, direction:-1});
    direction = 0;
    h.poll(); h.tick(); await settle();
    assert.equal(h.sent.at(-1).throttle, 0);
    h.button(12, false); h.button(13, true); h.device.axes[3] = .4;
    h.poll(); h.tick(); await settle();
    assert.equal(h.sent.at(-1).brake, 1);
});
test('deadzone spans the remaining full travel linearly', () => {
    assert.equal(analogAxis(.15),0); assert.equal(analogAxis(-.1),0);
    assert.equal(analogAxis(1),1); assert.equal(analogAxis(-1),-1);
    assert.ok(Math.abs(analogAxis(.575)-.5)<1e-12);
});

test('emergency remains latched after returning to neutral', async t => {
    const h = setup(t);
    await h.arm();
    h.device.axes = [0, 0, 0, -1];
    h.poll();
    await settle();
    h.button(1, true);
    h.poll();
    await settle();
    h.button(1, false);
    h.device.axes.fill(0); h.poll();
    h.device.axes[3] = -1; h.poll();
    h.tick();
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'emergency_stop']);
    assert.equal(h.input.isGamepadEnabled, false);
    assert.equal(h.timers.size, 0);
});

test('webpage emergency also prevents the next poll from resuming held motion', async t => {
    const h = setup(t);
    await h.arm();
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
    h.device.axes[3] = -1;
    h.poll();
    await settle();
    h.advance(TELEOP_TIMING.gamepadSampleTimeoutMs + 1);
    h.tick();
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'stop']);
    assert.equal(h.input.isGamepadEnabled, false);
    assert.equal(h.timers.size, 0);
});

test('mapping edits stop immediately and invalidate confirmation', async t => {
    const h = setup(t);
    await h.arm();
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
    h.poll();
    h.poll();
    await settle();
    h.sent.length = 0;
    h.device.axes[3] = 1;
    h.poll();
    await settle();
    assert.deepEqual(h.actions(), ['forward']);
    h.monitor.setMapping({...defaultGamepadMapping, axisX: -1, axisY: -1});
    h.device.axes = [0, 0, 0, 0];
    h.monitor.confirmMapping(true);
    h.poll();
    h.poll();
    await settle();
    h.sent.length = 0;
    h.button(14, true);
    h.poll();
    await settle();
    assert.deepEqual(h.actions(), ['left']);
});

test('keyboard takes ownership without concurrent gamepad movement', async t => {
    const h = setup(t);
    await h.arm();
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
});

class Events {
    listeners = new Map(); hidden = false; activeElement = null;
    hasFocus() { return true; }
    addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]); }
    removeEventListener(name, callback) { this.listeners.set(name, this.listeners.get(name)?.filter(item => item !== callback)); }
    emit(name, props = {}) { this.listeners.get(name)?.forEach(callback => callback({target: this, ...props})); }
}

test('RT held across a background polling gap waits for release and a new press', t => {
    let presses = 0;
    const h = setup(t, undefined, undefined, undefined, {standardMapping: defaultGamepadMapping, toggleControl: () => presses++});
    const win = new Events(), doc = new Events();
    const cleanup = bindGamepadInput(h.monitor, win, doc, {getGamepads: () => [h.device]});
    try {
        win.emit('blur');
        h.button(7, true);
        win.emit('focus');
        h.tick(TELEOP_TIMING.gamepadPollMs);
        assert.equal(presses, 0);
        h.button(7, false); h.tick(TELEOP_TIMING.gamepadPollMs);
        h.button(7, true); h.tick(TELEOP_TIMING.gamepadPollMs);
        assert.equal(presses, 1);
    } finally { cleanup(); }
});

test('browser disconnect event and blur immediately stop; cleanup removes polling', async t => {
    const h = setup(t), win = new Events(), doc = new Events();
    bindKeyboardInput(h.input, win, doc);
    let pads = [h.device];
    const cleanup = bindGamepadInput(h.monitor, win, doc, {getGamepads: () => pads});
    await h.arm();
    h.device.axes[3] = -1;
    h.tick(TELEOP_TIMING.gamepadPollMs);
    await settle();
    win.emit('blur');
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'stop']);
    assert.equal(h.input.isGamepadEnabled, false);
    h.device.axes[3] = 0;
    await h.arm();
    h.device.axes[3] = -1;
    h.tick(TELEOP_TIMING.gamepadPollMs);
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

test('emergency is available while waiting for takeover', async t => {
    const h = setup(t, undefined, undefined, undefined, {canDrive: () => false});
    await h.arm();
    h.button(1, true);
    h.poll();
    await settle();
    assert.deepEqual(h.actions(), ['emergency_stop']);
    assert.equal(h.input.isGamepadEnabled, false);
});


test('centering replaces all queued analog changes with stop while publication is blocked', async t => {
    let release, blocked = false;
    const h = setup(t, command => {
        if (command.mode === 'low_level' && !blocked) {
            blocked = true;
            return new Promise(resolve => { release = resolve; });
        }
    });
    await h.arm(); h.device.axes = [.3, 0, 0, -.6]; h.poll();
    h.device.axes = [.8, 0, 0, -.9]; h.poll(); h.tick();
    h.device.axes = [.2, 0, 0, -.3]; h.poll();
    h.device.axes.fill(0); h.poll(); release(); await settle();
    assert.equal(h.sent.length,2);
    assert.equal(h.sent[0].mode,'low_level');
    assert.equal(h.sent[1].action,'stop');
    assert.equal(h.timers.size,0);
});


test('left vertical and right horizontal axes do not drive or steer', async t => {
    const h = setup(t); await h.arm();
    h.device.axes = [0,-1,1,0]; h.poll(); h.tick(); await settle();
    assert.deepEqual(h.sent, []);
});
