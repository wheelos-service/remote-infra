/** Display intent is independent of actuator acknowledgement. Stop never changes view. */
export class CameraView {
    constructor() {
        this.mode = 'auto';
        this.automatic = 'front';
    }
    get group() { return this.mode === 'auto' ? this.automatic : this.mode; }
    get status() {
        const view = this.group === 'rear' ? '后方' : '前方';
        const gear = this.confirmed === 'rear' ? '倒挡已确认'
            : this.confirmed === 'front' ? '前进挡已确认' : '挡位未确认或数据已过期';
        const pending = this.requested ? `；${this.requested === 'rear' ? '倒挡' : '前进挡'}请求中` : '';
        return `${this.mode === 'auto' ? '自动' : '手动'}：${view}画面；${gear}${pending}`;
    }
    setMode(mode) { this.mode = mode; }
    command(command) {
        let group;
        if (command.mode === 'high_level') {
            if (command.action === 'reverse')
                group = 'rear';
            if (command.action === 'forward')
                group = 'front';
        }
        else if ((command.throttle ?? 0) > 0 && (command.brake ?? 0) === 0) {
            if (command.direction === -1)
                group = 'rear';
            if (command.direction === 1)
                group = 'front';
        }
        if (!group)
            return;
        this.automatic = group;
        this.requested = this.confirmed === group ? undefined : group;
    }
    gear(gear) {
        this.confirmed = gear === 'GEAR_REVERSE' ? 'rear'
            : gear === 'GEAR_DRIVE' || gear === 'GEAR_LOW' ? 'front' : undefined;
        if (this.requested === this.confirmed)
            this.requested = undefined;
        if (!this.requested && this.confirmed)
            this.automatic = this.confirmed;
    }
    clearIntent() {
        this.requested = undefined;
        if (this.confirmed)
            this.automatic = this.confirmed;
    }
    reset() {
        this.mode = 'auto';
        this.automatic = 'front';
        this.requested = this.confirmed = undefined;
    }
}
