import assert from 'node:assert/strict';
import test from 'node:test';
import {webcrypto} from 'node:crypto';
import {SecureControlSender} from '../dist/lib/secure-control-sender.js';

async function sender(t) {
    let publicKey;
    t.mock.method(globalThis, 'fetch', async (url, options) => {
        if (url.endsWith('/acquire')) publicKey = JSON.parse(options.body).public_key_b64;
        return Response.json({session: {session_id: 'session-1'}, renew_after_ms: 1000});
    });
    const sender = new SecureControlSender({
        gatewayBaseUrl: 'http://gateway', vehicleId: 'car-1', authToken: 'test-token',
    });
    await sender.createKeyPair();
    await sender.acquireSession();
    return {sender, publicKey};
}

test('signed commands remain compatible with vehicle verification', async t => {
    const {sender: control, publicKey} = await sender(t);
    let packet;
    control.setPublishData(async message => { packet = JSON.parse(message); });
    await control.sendCommand({mode: 'low_level', steering: -0.2, throttle: 0.1, brake: 0, direction: 1});
    const key = await crypto.subtle.importKey('raw', Buffer.from(publicKey, 'base64'), 'Ed25519', false, ['verify']);
    const signed = `1|control|session-1|1|${packet.timestamp_ms}|low_level|-0.2|0.1|0|1`;
    assert.ok(await crypto.subtle.verify('Ed25519', key, Buffer.from(packet.signature, 'base64'),
        new TextEncoder().encode(signed)));
});

test('gear and mode actions are covered by the existing high-level signature', async t => {
    const {sender: control, publicKey} = await sender(t);
    let packet;
    control.setPublishData(async message => { packet = JSON.parse(message); });
    const key = await crypto.subtle.importKey('raw', Buffer.from(publicKey, 'base64'), 'Ed25519', false, ['verify']);
    for (const action of ['gear_park', 'gear_neutral', 'gear_drive', 'gear_reverse', 'auto_enter', 'auto_exit']) {
        await control.sendCommand({mode: 'high_level', action});
        const prefix = `1|control|session-1|${packet.sequence}|${packet.timestamp_ms}|high_level|`;
        const verify = value => crypto.subtle.verify('Ed25519', key, Buffer.from(packet.signature, 'base64'),
            new TextEncoder().encode(prefix + value));
        assert.ok(await verify(action));
        assert.equal(await verify('stop'), false);
    }
});

test('blocked publication never queues concurrent commands', async t => {
    const {sender: control} = await sender(t);
    let release, started;
    const blocked = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    let count = 0;
    control.setPublishData(async () => { count += 1; started(); await blocked; });
    const pending = control.sendCommand({mode: 'high_level', action: 'forward'});
    await entered;
    await control.sendCommand({mode: 'high_level', action: 'left'});
    assert.equal(count, 1);
    release();
    await pending;
    await control.sendCommand({mode: 'high_level', action: 'stop'});
    assert.equal(count, 2);
});

test('session release during signing prevents late control publication', async t => {
    const {sender: control} = await sender(t);
    let count = 0;
    control.setPublishData(async () => { count += 1; });
    const pending = control.sendCommand({mode: 'high_level', action: 'forward'});
    await control.release();
    await pending;
    assert.equal(count, 0);
});

test('accepted release is not a confirmed handover and cannot reacquire', async t => {
    const {sender: control} = await sender(t);
    t.mock.method(globalThis, 'fetch', async () => Response.json({
        vehicle_id: 'car-1', session_id: 'session-1', state: 'PENDING',
        vehicle_handover_confirmed: false,
    }, {status: 202}));
    await assert.rejects(() => control.release(), /NOT confirmed/);
    await assert.rejects(() => control.acquireSession(), /handover is pending/);
    await assert.rejects(() => control.sendCommand({mode: 'high_level', action: 'forward'}), /not initialized/);
});

test('lost release response keeps the handover fence closed', async t => {
    const {sender: control} = await sender(t);
    t.mock.method(globalThis, 'fetch', async () => { throw new Error('release response lost'); });
    await assert.rejects(() => control.release(), /response lost/);
    await assert.rejects(() => control.acquireSession(), /handover is pending/);
    await assert.rejects(() => control.sendCommand({mode: 'high_level', action: 'forward'}), /not initialized/);
});

test('failed renewal cancels renewal timer and notifies the page', async t => {
    const originalFetch = globalThis.fetch;
    const originalSet = globalThis.setInterval;
    const originalClear = globalThis.clearInterval;
    const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    Object.defineProperty(globalThis, 'crypto', {value: webcrypto, configurable: true});
    let tick, cleared = false, failed = false;
    const errors = [];
    globalThis.setInterval = (callback, delay) => {
        assert.equal(delay, 15000);
        tick = callback;
        return 42;
    };
    globalThis.clearInterval = id => { if (id === 42) cleared = true; };
    globalThis.fetch = async (url, request) => {
        if (url.endsWith('/acquire')) {
            assert.ok(JSON.parse(request.body).public_key_b64);
            return {ok: true, json: async () => ({session: {session_id: 'test-session'}, renew_after_ms: 15000})};
        }
        assert.ok(url.endsWith('/renew'));
        failed = true;
        return {ok: false, status: 404};
    };
    t.after(() => {
        globalThis.fetch = originalFetch;
        globalThis.setInterval = originalSet;
        globalThis.clearInterval = originalClear;
        if (cryptoDescriptor) Object.defineProperty(globalThis, 'crypto', cryptoDescriptor);
        else delete globalThis.crypto;
    });
    const sender = new SecureControlSender({
        gatewayBaseUrl: 'http://test-gateway', vehicleId: 'test-car', authToken: 'test-token',
        onRenewalError: error => errors.push(error),
    });
    await sender.createKeyPair();
    await sender.acquireSession();
    sender.startRenewal();
    await tick();
    assert.equal(failed, true);
    assert.equal(cleared, true);
    assert.equal(errors.length, 1);
    assert.match(errors[0].message, /404/);
});
