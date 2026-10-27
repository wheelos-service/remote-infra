import assert from 'node:assert/strict';
import test from 'node:test';
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
