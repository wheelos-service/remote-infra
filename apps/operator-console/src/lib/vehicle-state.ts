type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as RecordValue : {};
}

function number(value: unknown, digits = 2): string {
    return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '--';
}

function label(value: unknown): string {
    return typeof value === 'string' ? value : '--';
}

export class VehicleStateMonitor {
    private packet?: RecordValue;
    private receivedAt = 0;
    private vehiclePresent?: boolean;
    private dataCount = 0;
    private stateCount = 0;
    private waitingReason = '尚未收到状态包';
    private readonly retiredStreams = new Set<string>();
    private readonly timer: ReturnType<typeof setInterval>;

    constructor(private readonly element: HTMLElement, private readonly vehicleId: string,
        private readonly onGear?: (gear?: string) => void) {
        this.timer = setInterval(() => this.render(), 250);
        this.render();
    }

    noteVehiclePresent(present: boolean): void {
        this.vehiclePresent = present;
        this.render();
    }

    private reject(reason: string): false {
        this.waitingReason = reason;
        if (!this.packet) this.render();
        return false;
    }

    receive(data: Uint8Array, participant: {identity: string} | undefined, topic?: string): boolean {
        this.dataCount++;
        if (topic !== 'vehicle.state') return this.reject('收到数据，但主题不是 vehicle.state');
        this.stateCount++;
        if (participant?.identity !== `vehicle-${this.vehicleId}`) {
            return this.reject('状态包发送者与目标车辆不匹配');
        }
        if (data.byteLength > 12000) return this.reject('状态包超过 12000 字节');
        let packet: RecordValue;
        try {
            packet = record(JSON.parse(new TextDecoder().decode(data)));
        } catch {
            return this.reject('状态包不是有效 JSON');
        }
        if (packet.version !== 1 || packet.type !== 'vehicle_state') {
            return this.reject('状态包协议版本或类型不匹配');
        }
        if (packet.vehicle_id !== this.vehicleId) return this.reject('状态包 vehicle_id 不匹配');
        if (typeof packet.stream_id !== 'string' || packet.stream_id.length === 0
            || packet.stream_id.length > 64) return this.reject('状态包缺少有效 stream_id');
        if (!Number.isSafeInteger(packet.sequence) || (packet.sequence as number) < 1) {
            return this.reject('状态包缺少有效 sequence');
        }
        if (typeof packet.timestamp_ms !== 'number' || !Number.isFinite(packet.timestamp_ms)) {
            return this.reject('状态包缺少有效 timestamp_ms');
        }
        if (this.retiredStreams.has(packet.stream_id)) return this.reject('状态包来自已结束的数据流');
        if (this.packet?.stream_id === packet.stream_id) {
            if ((packet.sequence as number) <= (this.packet.sequence as number)) {
                return this.reject('状态包序号重复或乱序');
            }
        } else if (this.packet) {
            this.retiredStreams.add(this.packet.stream_id as string);
            if (this.retiredStreams.size > 16) {
                this.retiredStreams.delete(this.retiredStreams.values().next().value!);
            }
        }
        this.packet = packet;
        this.receivedAt = performance.now();
        this.render();
        return true;
    }

    private render(): void {
        if (!this.packet) {
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
        const freshness = (sample: RecordValue) => {
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

    close(): void {
        clearInterval(this.timer);
        this.packet = undefined;
        this.retiredStreams.clear();
        this.onGear?.(undefined);
        this.element.textContent = 'MONITOR: OFFLINE';
    }
}
