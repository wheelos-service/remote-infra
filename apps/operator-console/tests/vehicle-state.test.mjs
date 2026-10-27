import assert from 'node:assert/strict';
import test from 'node:test';
import {VehicleStateMonitor} from '../dist/lib/vehicle-state.js';

function packet(overrides = {}) {
    return {
        version: 1, type: 'vehicle_state', vehicle_id: 'car-1',
        stream_id: 'stream-1', sequence: 1, timestamp_ms: Date.now(),
        localization: {stale: false, age_ms: 0, message: {
            pose: {position: {x: 12.5, y: 34.5}, heading: 0.25},
        }},
        chassis: {stale: false, age_ms: 0, message: {
            speed_mps: 2.5, gear_location: 'GEAR_DRIVE', driving_mode: 'COMPLETE_AUTO_DRIVE',
        }},
        control: {state: 'active', last_published_sequence: 7, last_published_session_id: 'session-1'},
        ...overrides,
    };
}

function monitor(t) {
    const element = {textContent: ''};
    const monitor = new VehicleStateMonitor(element, 'car-1');
    t.after(() => monitor.close());
    const receive = (state, identity = 'vehicle-car-1', topic = 'vehicle.state') =>
        monitor.receive(new TextEncoder().encode(JSON.stringify(state)), {identity}, topic);
    return {element, monitor, receive};
}

test('renders position, chassis and publication feedback without treating publication as acknowledgement', t => {
    const {element, receive} = monitor(t);
    assert.ok(receive(packet()));
    assert.match(element.textContent, /12\.50, 34\.50/);
    assert.match(element.textContent, /speed\(m\/s\): 2\.50/);
    assert.match(element.textContent, /last published: 7/);
    assert.match(element.textContent, /NOT actuator acknowledgement/);
});

test('waiting display distinguishes absent vehicle, no packets and rejected packets', t => {
    const {element, monitor: receiver, receive} = monitor(t);
    receiver.noteVehiclePresent(false);
    assert.match(element.textContent, /房间内车辆: 未加入/);
    assert.match(element.textContent, /收到数据包: 0 \| vehicle.state: 0/);
    receiver.noteVehiclePresent(true);
    assert.match(element.textContent, /房间内车辆: 已加入/);
    assert.equal(receive(packet(), 'vehicle-car-1', 'other'), false);
    assert.match(element.textContent, /收到数据包: 1 \| vehicle.state: 0/);
    assert.match(element.textContent, /主题不是 vehicle.state/);
    assert.equal(receive(packet(), 'vehicle-other'), false);
    assert.match(element.textContent, /发送者与目标车辆不匹配/);
    const missingStream = packet();
    delete missingStream.stream_id;
    assert.equal(receive(missingStream), false);
    assert.match(element.textContent, /缺少有效 stream_id/);
    assert.match(element.textContent, /收到数据包: 3 \| vehicle.state: 2/);
    assert.ok(receive(packet()));
    assert.match(element.textContent, /MONITOR: LIVE/);
    assert.doesNotMatch(element.textContent, /等待原因/);
});

test('rejects other senders, topics, vehicles and malformed data without replacing state', t => {
    const {element, monitor: receiver, receive} = monitor(t);
    assert.ok(receive(packet()));
    const original = element.textContent;
    for (const [state, identity, topic] of [
        [packet(), 'operator-1', 'vehicle.state'],
        [packet(), 'vehicle-car-2', 'vehicle.state'],
        [packet(), 'vehicle-car-1', 'vehicle.control'],
        [packet({vehicle_id: 'car-2'})],
        [packet({sequence: -1})],
        [packet({sequence: '2'})],
        [packet({stream_id: ''})],
        [null],
    ]) {
        assert.equal(receive(state, identity, topic), false);
    }
    assert.equal(receiver.receive(new TextEncoder().encode('{invalid'),
        {identity: 'vehicle-car-1'}, 'vehicle.state'), false);
    assert.equal(element.textContent, original);
});

test('drops reordered packets and retired streams while accepting a restarted publisher', t => {
    const {receive} = monitor(t);
    assert.ok(receive(packet({sequence: 10})));
    assert.equal(receive(packet({sequence: 9})), false);
    assert.equal(receive(packet({sequence: 10})), false);
    assert.ok(receive(packet({stream_id: 'stream-2', sequence: 1})));
    assert.equal(receive(packet({sequence: 11})), false);
    assert.ok(receive(packet({stream_id: 'stream-2', sequence: 2})));
});

test('marks source samples and disconnected stream stale; close removes the display', t => {
    let now = 100;
    t.mock.method(performance, 'now', () => now);
    t.mock.timers.enable({apis: ['setInterval']});
    const {element, monitor: receiver, receive} = monitor(t);
    assert.ok(receive(packet({chassis: {stale: false, age_ms: 1500, message: {speed_mps: null}}})));
    assert.match(element.textContent, /CHASSIS \[STALE\] speed\(m\/s\): --/);
    now += 1100;
    t.mock.timers.tick(250);
    assert.match(element.textContent, /MONITOR: STALE/);
    assert.match(element.textContent, /CONTROL: STALE/);
    receiver.close();
    assert.equal(element.textContent, 'MONITOR: OFFLINE');
});

test('vehicle-supplied strings are rendered as text, never HTML', t => {
    const {element, receive} = monitor(t);
    assert.ok(receive(packet({control: {state: '<img src=x onerror=alert(1)>'}})));
    assert.match(element.textContent, /<img src=x/);
    assert.equal(element.innerHTML, undefined);
});

test('camera view receives only validated fresh gear and is notified of expiry and disconnect', t => {
    let now = 100;
    t.mock.method(performance, 'now', () => now);
    t.mock.timers.enable({apis: ['setInterval']});
    const gears = [], element = {textContent: ''};
    const receiver = new VehicleStateMonitor(element, 'car-1', gear => gears.push(gear));
    t.after(() => receiver.close());
    const data = state => new TextEncoder().encode(JSON.stringify(state));
    receiver.receive(data(packet()), {identity: 'vehicle-other'}, 'vehicle.state');
    assert.equal(gears.at(-1), undefined);
    receiver.receive(data(packet({chassis: {stale: false, age_ms: 0,
        message: {gear_location: 'GEAR_REVERSE'}}})), {identity: 'vehicle-car-1'}, 'vehicle.state');
    assert.equal(gears.at(-1), 'GEAR_REVERSE');
    now += 1100; t.mock.timers.tick(250);
    assert.equal(gears.at(-1), undefined);
    receiver.receive(data(packet({sequence: 2, chassis: {stale: true, age_ms: 0,
        message: {gear_location: 'GEAR_DRIVE'}}})), {identity: 'vehicle-car-1'}, 'vehicle.state');
    assert.equal(gears.at(-1), undefined);
    receiver.close(); assert.equal(gears.at(-1), undefined);
});
