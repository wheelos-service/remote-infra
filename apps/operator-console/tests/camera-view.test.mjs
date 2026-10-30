import test from 'node:test';
import assert from 'node:assert/strict';
import {CameraView} from '../dist/lib/camera-view.js';
const command = action => ({mode: 'high_level', action});
test('reverse request, confirmation, stop, emergency and stale feedback retain correct view', () => {
    const v = new CameraView();
    v.gear('GEAR_DRIVE'); v.command(command('reverse'));
    assert.equal(v.group, 'rear'); assert.match(v.status, /倒挡请求中/);
    v.gear('GEAR_DRIVE');
    assert.equal(v.group, 'rear');
    for (const action of ['stop', 'emergency_stop', 'left', 'right']) v.command(command(action));
    assert.equal(v.group, 'rear');
    v.gear('GEAR_REVERSE');
    assert.match(v.status, /倒挡已确认/); assert.doesNotMatch(v.status, /请求中/);
    v.gear(undefined); assert.equal(v.group, 'rear'); assert.match(v.status, /数据已过期/);
    v.command(command('forward')); assert.equal(v.group, 'front');
});
test('observer gear and manual override do not send or change control commands', () => {
    const v = new CameraView();
    v.gear('GEAR_REVERSE'); assert.equal(v.group, 'rear');
    v.gear('GEAR_NEUTRAL'); assert.equal(v.group, 'rear');
    v.gear('GEAR_DRIVE'); assert.equal(v.group, 'front');
    v.setMode('front'); v.command(command('reverse')); v.gear('GEAR_REVERSE');
    assert.equal(v.group, 'front');
    v.setMode('auto'); assert.equal(v.group, 'rear');
    v.reset(); assert.equal(v.group, 'front'); assert.match(v.status, /自动/);
});
test('low-level propulsion changes view; braking and steering-only do not', () => {
    const v = new CameraView(), low = {mode: 'low_level', throttle: .2, brake: 0, direction: -1};
    v.command(low); assert.equal(v.group, 'rear');
    v.command({...low, direction: 1, throttle: 0, steering: 1});
    v.command({...low, direction: 1, brake: 1}); assert.equal(v.group, 'rear');
    v.command({...low, direction: 1}); assert.equal(v.group, 'front');
});
