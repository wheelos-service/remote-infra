import test from 'node:test';
import assert from 'node:assert/strict';
import {ControlInput, bindKeyboardInput} from '../dist/lib/control-input.js';

const settle = () => new Promise(resolve => setImmediate(resolve));

function setup(t, send) {
    const sent = [], states = [], errors = [], timers = new Map();
    const originalSet = globalThis.setInterval;
    const originalClear = globalThis.clearInterval;
    let timerId = 0;
    globalThis.setInterval = (callback, delay) => {
        assert.equal(delay, 100);
        timers.set(++timerId, callback);
        return timerId;
    };
    globalThis.clearInterval = id => timers.delete(id);
    const input = new ControlInput({
        send: async command => { sent.push(command); await send?.(command); },
        onChange: state => states.push(state),
        onError: error => errors.push(error),
    });
    t.after(() => {
        input.setAvailable(false);
        globalThis.setInterval = originalSet;
        globalThis.clearInterval = originalClear;
    });
    return {
        input, sent, states, errors, timers,
        tick: () => [...timers.values()].forEach(callback => callback()),
        actions: () => sent.map(command => command.action),
        async arm() {
            input.setAvailable(true);
            input.setKeyboardEnabled(true);
            await settle();
            sent.length = 0;
        },
    };
}

test('unavailable observers and unarmed controllers cannot send keyboard commands', async t => {
    const h = setup(t);
    h.input.setKeyboardEnabled(true);
    h.input.keyDown('KeyW');
    h.input.setAvailable(true);
    h.input.keyDown('ArrowUp');
    await settle();
    assert.deepEqual(h.actions(), []);
    assert.equal(h.timers.size, 0);
});

test('all eight direction keys map to the existing high-level commands', async t => {
    const h = setup(t);
    await h.arm();
    for (const [key, action] of Object.entries({
        KeyW: 'forward', ArrowUp: 'forward', KeyS: 'reverse', ArrowDown: 'reverse',
        KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
    })) {
        h.sent.length = 0;
        h.input.keyDown(key);
        await settle();
        assert.deepEqual(h.sent, [{mode: 'high_level', action}]);
        h.input.keyUp(key);
        await settle();
        assert.deepEqual(h.actions(), [action, 'stop']);
    }
});

test('holding repeats at 100ms with one timer; OS repeat creates no extra sends', async t => {
    const h = setup(t);
    await h.arm();
    h.input.keyDown('KeyW');
    h.input.keyDown('KeyW', true);
    h.input.keyDown('KeyW');
    await settle();
    assert.deepEqual(h.actions(), ['forward']);
    assert.equal(h.timers.size, 1);
    h.tick();
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'forward']);
    h.input.keyUp('KeyW');
    await settle();
    h.tick();
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.actions(), ['forward', 'forward', 'stop']);
});

test('conflicting directions stop and require all keys to be released', async t => {
    const h = setup(t);
    await h.arm();
    h.input.keyDown('KeyW');
    await settle();
    h.input.keyDown('KeyA');
    await settle();
    h.input.keyUp('KeyA');
    h.input.keyDown('KeyD');
    h.input.keyUp('KeyD');
    h.input.keyUp('KeyW');
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'stop']);
    assert.equal(h.timers.size, 0);
    h.input.keyDown('KeyD');
    await settle();
    assert.equal(h.actions().at(-1), 'right');
});

test('space overrides motion and held directions cannot resume after emergency stop', async t => {
    const h = setup(t);
    await h.arm();
    h.input.keyDown('KeyW');
    await settle();
    h.input.keyDown('Space');
    await settle();
    h.input.keyUp('Space');
    h.input.keyDown('KeyW', true);
    h.tick();
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'emergency_stop']);
    assert.equal(h.timers.size, 0);
    h.input.keyUp('KeyW');
    h.input.keyDown('KeyW');
    await settle();
    assert.equal(h.actions().at(-1), 'forward');
});

test('pointer replaces keyboard with one scheduler and global release stops it', async t => {
    const h = setup(t);
    await h.arm();
    h.input.keyDown('KeyW');
    await settle();
    h.input.beginPointer({mode: 'high_level', action: 'left'});
    await settle();
    h.input.keyDown('KeyW', true);
    assert.equal(h.input.isKeyboardEnabled, false);
    assert.equal(h.timers.size, 1);
    h.input.endPointer();
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'left', 'stop']);
    assert.equal(h.timers.size, 0);
});

test('release replaces queued motion while an earlier send is still in flight', async t => {
    let unblock;
    const h = setup(t, command => command.action === 'forward' ? new Promise(resolve => { unblock = resolve; }) : undefined);
    await h.arm();
    h.input.keyDown('KeyW');
    h.tick();
    h.tick();
    h.input.keyUp('KeyW');
    unblock();
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'stop']);
});

test('send failure clears movement and disarms keyboard', async t => {
    const h = setup(t, command => {
        if (command.action === 'forward') throw new Error('offline');
    });
    await h.arm();
    h.input.keyDown('KeyW');
    await settle();
    assert.equal(h.input.isKeyboardEnabled, false);
    assert.equal(h.timers.size, 0);
    assert.equal(h.errors.length, 1);
    h.input.keyDown('KeyD');
    assert.deepEqual(h.actions(), ['forward']);
});

test('successive lifecycle events preserve a queued stop behind an in-flight command', async t => {
    let unblock;
    const h = setup(t, command => command.action === 'forward' ? new Promise(resolve => { unblock = resolve; }) : undefined);
    await h.arm();
    h.input.keyDown('KeyW');
    h.input.suspend('blur');
    h.input.suspend('hidden');
    unblock();
    await settle();
    assert.deepEqual(h.actions(), ['forward', 'stop']);
    assert.equal(h.input.isKeyboardEnabled, false);
    assert.equal(h.timers.size, 0);
});

class Events {
    listeners = new Map();
    hidden = false;
    focused = true;
    addEventListener(name, callback) {
        const callbacks = this.listeners.get(name) ?? [];
        callbacks.push(callback);
        this.listeners.set(name, callbacks);
    }
    hasFocus() { return this.focused; }
    emit(name, props = {}) {
        const event = {target: this, preventDefault() { this.prevented = true; }, ...props};
        this.listeners.get(name)?.forEach(callback => callback(event));
        return event;
    }
}

test('browser bindings ignore editors, composition, modifiers, hidden and unfocused pages', async t => {
    const h = setup(t);
    const win = new Events(), doc = new Events();
    bindKeyboardInput(h.input, win, doc);
    await h.arm();
    const editor = {closest: () => ({})};
    for (const props of [{target: editor}, {ctrlKey: true}, {altKey: true}, {metaKey: true}, {isComposing: true}]) {
        const event = win.emit('keydown', {code: 'KeyW', ...props});
        assert.equal(event.prevented, undefined);
    }
    doc.hidden = true;
    win.emit('keydown', {code: 'KeyW'});
    doc.hidden = false;
    doc.focused = false;
    win.emit('keydown', {code: 'KeyW'});
    await settle();
    assert.deepEqual(h.actions(), []);
});

test('blur, hiding, editor focus and disabling stop and require explicit rearming', async t => {
    const h = setup(t);
    const win = new Events(), doc = new Events();
    bindKeyboardInput(h.input, win, doc);
    for (const deactivate of [
        () => win.emit('blur'),
        () => { doc.hidden = true; doc.emit('visibilitychange'); },
        () => doc.emit('focusin', {target: {closest: () => ({})}}),
        () => h.input.setKeyboardEnabled(false),
    ]) {
        doc.hidden = false;
        await h.arm();
        assert.equal(win.emit('keydown', {code: 'KeyW'}).prevented, true);
        await settle();
        deactivate();
        await settle();
        doc.hidden = false;
        win.emit('keydown', {code: 'KeyD'});
        await settle();
        assert.deepEqual(h.actions(), ['forward', 'stop']);
        assert.equal(h.input.isKeyboardEnabled, false);
        assert.equal(h.timers.size, 0);
    }
});

test('disconnect clears held keys and reconnect stays disarmed', async t => {
    const h = setup(t);
    await h.arm();
    h.input.keyDown('KeyW');
    await settle();
    h.input.setAvailable(false);
    h.input.setAvailable(true);
    h.input.keyDown('KeyW', true);
    h.tick();
    await settle();
    assert.deepEqual(h.actions(), ['forward']);
    assert.equal(h.timers.size, 0);
    assert.equal(h.input.isKeyboardEnabled, false);
});

test('keyboard toggle focus does not silently re-enable an explicitly disabled checkbox', async t => {
    const h = setup(t);
    const win = new Events(), doc = new Events();
    const toggle = {closest: () => ({})};
    bindKeyboardInput(h.input, win, doc, toggle);
    await h.arm();
    doc.emit('focusin', {target: toggle});
    assert.equal(h.input.isKeyboardEnabled, true);
    h.input.setKeyboardEnabled(false);
    await settle();
    assert.equal(h.input.isKeyboardEnabled, false);
});

test('pointer cancellation and release outside the button use the common stop path', async t => {
    const h = setup(t);
    const win = new Events(), doc = new Events();
    bindKeyboardInput(h.input, win, doc);
    h.input.setAvailable(true);
    for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        h.sent.length = 0;
        h.input.beginPointer({mode: 'high_level', action: 'left'});
        await settle();
        win.emit(name);
        await settle();
        assert.deepEqual(h.actions(), ['left', 'stop']);
        assert.equal(h.timers.size, 0);
    }
});
