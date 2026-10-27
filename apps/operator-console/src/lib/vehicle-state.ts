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
    private readonly retiredStreams = new Set<string>();
    private readonly timer: ReturnType<typeof setInterval>;

    constructor(private readonly element: HTMLElement, private readonly vehicleId: string) {
        this.timer = setInterval(() => this.render(), 250);
        this.render();
    }

    receive(data: Uint8Array, participant: {identity: string} | undefined, topic?: string): boolean {
        if (topic !== 'vehicle.state' || participant?.identity !== `vehicle-${this.vehicleId}`
            || data.byteLength > 12000) return false;
        let packet: RecordValue;
        try {
            packet = record(JSON.parse(new TextDecoder().decode(data)));
        } catch {
            return false;
        }
        if (packet.version !== 1 || packet.type !== 'vehicle_state'
            || packet.vehicle_id !== this.vehicleId || typeof packet.stream_id !== 'string'
            || packet.stream_id.length === 0 || packet.stream_id.length > 64
            || !Number.isSafeInteger(packet.sequence) || (packet.sequence as number) < 1
            || typeof packet.timestamp_ms !== 'number' || !Number.isFinite(packet.timestamp_ms)
            || this.retiredStreams.has(packet.stream_id)) return false;
        if (this.packet?.stream_id === packet.stream_id) {
            if ((packet.sequence as number) <= (this.packet.sequence as number)) return false;
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
            this.element.textContent = 'MONITOR: WAITING FOR VEHICLE STATE';
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
        this.element.textContent = 'MONITOR: OFFLINE';
    }
}
