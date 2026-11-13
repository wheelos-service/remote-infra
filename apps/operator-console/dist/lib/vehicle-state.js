function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value : {};
}
function number(value, digits = 2) {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '--';
}
function label(value) {
    return typeof value === 'string' ? value : '--';
}
export class VehicleStateMonitor {
    constructor(element, vehicleId, onGear, summary) {
        this.element = element;
        this.vehicleId = vehicleId;
        this.onGear = onGear;
        this.summary = summary;
        this.receivedAt = 0;
        this.dataCount = 0;
        this.stateCount = 0;
        this.waitingReason = '尚未收到状态包';
        this.retiredStreams = new Set();
        this.timer = setInterval(() => this.render(), 250);
        this.render();
    }
    noteVehiclePresent(present) {
        this.vehiclePresent = present;
        this.render();
    }
    reject(reason) {
        this.waitingReason = reason;
        if (!this.packet)
            this.render();
        return false;
    }
    receive(data, participant, topic) {
        this.dataCount++;
        if (topic !== 'vehicle.state')
            return this.reject('收到数据，但主题不是 vehicle.state');
        this.stateCount++;
        if (participant?.identity !== `vehicle-${this.vehicleId}`) {
            return this.reject('状态包发送者与目标车辆不匹配');
        }
        if (data.byteLength > 12000)
            return this.reject('状态包超过 12000 字节');
        let packet;
        try {
            packet = record(JSON.parse(new TextDecoder().decode(data)));
        }
        catch {
            return this.reject('状态包不是有效 JSON');
        }
        if (packet.version !== 1 || packet.type !== 'vehicle_state') {
            return this.reject('状态包协议版本或类型不匹配');
        }
        if (packet.vehicle_id !== this.vehicleId)
            return this.reject('状态包 vehicle_id 不匹配');
        if (typeof packet.stream_id !== 'string' || packet.stream_id.length === 0
            || packet.stream_id.length > 64)
            return this.reject('状态包缺少有效 stream_id');
        if (!Number.isSafeInteger(packet.sequence) || packet.sequence < 1) {
            return this.reject('状态包缺少有效 sequence');
        }
        if (typeof packet.timestamp_ms !== 'number' || !Number.isFinite(packet.timestamp_ms)) {
            return this.reject('状态包缺少有效 timestamp_ms');
        }
        if (this.retiredStreams.has(packet.stream_id))
            return this.reject('状态包来自已结束的数据流');
        if (this.packet?.stream_id === packet.stream_id) {
            if (packet.sequence <= this.packet.sequence) {
                return this.reject('状态包序号重复或乱序');
            }
        }
        else if (this.packet) {
            this.retiredStreams.add(this.packet.stream_id);
            if (this.retiredStreams.size > 16) {
                this.retiredStreams.delete(this.retiredStreams.values().next().value);
            }
        }
        this.packet = packet;
        this.receivedAt = performance.now();
        this.render();
        return true;
    }
    setSummary(id, text) {
        const element = this.summary?.getElementById(id);
        if (element)
            element.textContent = text;
    }
    clearSummary(message) {
        for (const field of ['speed', 'gear', 'mode', 'battery'])
            this.setSummary(`state-${field}`, '—');
        this.setSummary('state-health', message);
        this.setSummary('state-safety', '');
    }
    render() {
        if (!this.packet) {
            this.clearSummary(this.vehiclePresent === false ? '目标车辆未加入，等待车辆上线' : '等待车辆状态');
            this.onGear?.(undefined);
            this.element.textContent = [
                'MONITOR: WAITING FOR VEHICLE STATE',
                `目标车辆: ${this.vehicleId} | 房间内车辆: ${this.vehiclePresent === undefined
                    ? '检查中' : this.vehiclePresent ? '已加入' : '未加入'}`,
                `收到数据包: ${this.dataCount} | vehicle.state: ${this.stateCount}`,
                `等待原因: ${this.waitingReason}`,
            ].join('\n');
            return;
        }
        const elapsed = Math.max(0, performance.now() - this.receivedAt);
        const freshness = (sample) => {
            const age = sample.age_ms;
            return elapsed > 1000 || sample.stale !== false || typeof age !== 'number'
                || !Number.isFinite(age) || age < 0 || age + elapsed > 1000 ? 'STALE' : 'LIVE';
        };
        const localization = record(this.packet.localization);
        const chassis = record(this.packet.chassis);
        const pose = record(record(localization.message).pose);
        const position = record(pose.position);
        const vehicle = record(chassis.message);
        const control = record(this.packet.control);
        this.onGear?.(freshness(chassis) === 'LIVE' && typeof vehicle.gear_location === 'string'
            ? vehicle.gear_location : undefined);
        const chassisLive = freshness(chassis) === 'LIVE';
        const translations = {
            GEAR_PARKING: 'P 驻车', GEAR_NEUTRAL: 'N 空挡', GEAR_DRIVE: 'D 前进',
            GEAR_REVERSE: 'R 倒车', GEAR_LOW: '低速挡', GEAR_NONE: '无挡位',
            COMPLETE_AUTO_DRIVE: '自动驾驶', COMPLETE_MANUAL: '手动驾驶',
            AUTO_STEER_ONLY: '自动转向', AUTO_SPEED_ONLY: '自动纵向', EMERGENCY_MODE: '紧急模式',
        };
        const display = (value) => typeof value === 'string' ? translations[value] || value : '—';
        this.setSummary('state-speed', chassisLive ? `${number(typeof vehicle.speed_mps === 'number' ? vehicle.speed_mps * 3.6 : undefined, 1)} km/h` : '—');
        this.setSummary('state-gear', chassisLive ? display(vehicle.gear_location) : '—');
        this.setSummary('state-mode', chassisLive ? display(vehicle.driving_mode) : '—');
        this.setSummary('state-battery', chassisLive ? `${number(vehicle.battery_soc_percentage, 0)} %` : '—');
        this.setSummary('state-health', elapsed > 1000 ? '车辆状态已过期，请勿依据旧数据操作'
            : !chassisLive ? '底盘反馈已过期或不可用' : '底盘反馈实时 · 控制请求不代表车辆已执行');
        const warnings = [];
        if (vehicle.error_code && vehicle.error_code !== 'NO_ERROR')
            warnings.push(`底盘故障：${label(vehicle.error_code)}`);
        if (typeof vehicle.chassis_error_mask === 'number' && vehicle.chassis_error_mask !== 0)
            warnings.push(`底盘故障掩码：${vehicle.chassis_error_mask}`);
        if (control.safety_reason)
            warnings.push(`安全提示：${label(control.safety_reason)}`);
        if (control.fault)
            warnings.push(`控制发布故障：${label(control.fault)}`);
        this.setSummary('state-safety', warnings.join('；'));
        this.element.textContent = [
            `MONITOR: ${elapsed > 1000 ? 'STALE' : 'LIVE'}`,
            `POSITION [${freshness(localization)}] ENU(m): ${number(position.x)}, ${number(position.y)}, ${number(position.z)} | heading(rad): ${number(pose.heading)}`,
            `CHASSIS [${freshness(chassis)}] speed(m/s): ${number(vehicle.speed_mps)} | gear: ${label(vehicle.gear_location)} | mode: ${label(vehicle.driving_mode)}`,
            `ACTUATORS(%) steer: ${number(vehicle.steering_percentage)} | throttle: ${number(vehicle.throttle_percentage)} | brake: ${number(vehicle.brake_percentage)}`,
            `FAULT: ${label(vehicle.error_code)} | mask: ${number(vehicle.chassis_error_mask, 0)} | battery(%): ${number(vehicle.battery_soc_percentage, 0)}`,
            `CONTROL: ${elapsed > 1000 ? 'STALE' : label(control.state)} | last published: ${number(control.last_published_sequence, 0)} | session: ${label(control.last_published_session_id)}`,
            `SAFETY: ${label(control.safety_reason)} | publication fault: ${label(control.fault)} | middleware publication is NOT actuator acknowledgement`,
        ].join('\n');
    }
    close() {
        clearInterval(this.timer);
        this.packet = undefined;
        this.retiredStreams.clear();
        this.onGear?.(undefined);
        this.element.textContent = 'MONITOR: OFFLINE';
        this.clearSummary('未连接');
    }
}
