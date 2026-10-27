import {ControlInput, isEditableTarget} from './control-input.js';

export type GamepadMapping = {
    axisX: number; axisY: number; invertX: boolean; invertY: boolean;
    enableButton: number; emergencyButton: number;
    upButton: number; downButton: number; leftButton: number; rightButton: number;
};

export const defaultGamepadMapping: GamepadMapping = {
    axisX: 0, axisY: 3, invertX: false, invertY: false,
    enableButton: 4, emergencyButton: 1,
    upButton: 12, downButton: 13, leftButton: 14, rightButton: 15,
};

export type Pad = Pick<Gamepad, 'index' | 'id' | 'mapping' | 'axes' | 'buttons' | 'connected'>;
export type GamepadView = {
    devices: {index: number; id: string}[];
    selectedIndex: number | null;
    pad: Pad | null;
    confirmed: boolean;
    canEnable: boolean;
    enableHeld: boolean;
    message: string;
    validation: string;
};

export function validateMapping(mapping: GamepadMapping, pad: Pad): string {
    const axes = [mapping.axisX, mapping.axisY];
    const directions = [mapping.upButton, mapping.downButton, mapping.leftButton, mapping.rightButton];
    const buttons = [mapping.enableButton, mapping.emergencyButton, ...directions];
    if (axes.some(index => !Number.isInteger(index) || index < -1 || index >= pad.axes.length) ||
        directions.some(index => !Number.isInteger(index) || index < -1) ||
        [mapping.enableButton, mapping.emergencyButton].some(index => !Number.isInteger(index) || index < 0) ||
        buttons.some(index => index >= pad.buttons.length)) return '映射编号超出当前手柄范围；不用的轴/方向键请填 -1';
    const enabledAxes = axes.filter(index => index >= 0);
    const enabledButtons = buttons.filter(index => index >= 0);
    if (new Set(enabledAxes).size !== enabledAxes.length ||
        new Set(enabledButtons).size !== enabledButtons.length) return '映射编号不能重复，使能与急停必须分开';
    if (!enabledAxes.length && !directions.some(index => index >= 0)) return '至少配置一个方向轴或方向按钮';
    return '';
}

export function analogAxis(value: number): number {
    const magnitude = Math.abs(value);
    return magnitude <= 0.15 ? 0 : Math.sign(value) * (magnitude - 0.15) / 0.85;
}

/** Inspect without sending; explicit mapping confirmation and arming permit control. */
export class GamepadInput {
    private selectedIndex: number | null = null;
    private autoSelect = true;
    private identity = '';
    private mapping: GamepadMapping = {...defaultGamepadMapping};
    private confirmed = false;
    private pad: Pad | null = null;
    private devices: GamepadView['devices'] = [];
    private foreground = false;
    private enabledPreviously = false;
    private needsNeutral = true;
    private lastDirection = 0;
    private message = '连接手柄后按一下按钮，先检测并确认映射';
    private validation = '';
    private enableHeld = false;

    constructor(private readonly input: ControlInput, private readonly onView: (view: GamepadView) => void) {}

    private report(): void {
        this.onView({devices: this.devices, selectedIndex: this.selectedIndex, pad: this.pad,
            confirmed: this.confirmed, enableHeld: this.enableHeld, message: this.message,
            validation: this.validation,
            canEnable: Boolean(this.pad && this.confirmed && !this.validation && this.foreground && this.input.isAvailable),
        });
    }

    select(index: number | null): void {
        this.disarm('已切换手柄，请重新检测并确认映射');
        this.selectedIndex = index;
        this.autoSelect = false;
        this.identity = '';
        this.pad = null;
        this.confirmed = false;
        this.report();
    }

    setMapping(mapping: GamepadMapping): void {
        this.disarm('映射已修改，请重新确认');
        this.mapping = {...mapping};
        this.confirmed = false;
        this.validation = this.pad ? validateMapping(this.mapping, this.pad) : '';
        this.report();
    }

    confirmMapping(confirmed: boolean): void {
        this.disarm(confirmed ? '映射已确认；启用后先松开使能键并回中' : '请先检测并确认映射');
        this.confirmed = Boolean(confirmed && this.pad && !validateMapping(this.mapping, this.pad));
        this.report();
    }

    setEnabled(enabled: boolean): void {
        if (enabled && (!this.pad || !this.confirmed || this.validation || !this.foreground || !this.input.isAvailable)) {
            this.disarm('当前不能启用手柄，请检查连接、映射和控制会话');
        } else {
            this.input.setGamepadEnabled(enabled);
            this.enabledPreviously = false;
            this.needsNeutral = true;
            this.message = enabled ? '先松开使能键、急停键，摇杆回中并松开方向键' : '手柄控制未启用';
        }
        this.report();
    }

    private disarm(message: string): void {
        if (this.input.isGamepadEnabled) this.input.suspend(message);
        this.enabledPreviously = false;
        this.needsNeutral = true;
        this.lastDirection = 0;
        this.message = message;
    }

    unavailable(message: string): void {
        this.disarm(message);
        this.pad = null;
        this.devices = [];
        this.confirmed = false;
        this.enableHeld = false;
        this.identity = '';
        this.report();
    }

    disconnected(index: number): void {
        if (index === this.selectedIndex) this.unavailable('手柄已断开：已停止，重连后需重新确认并启用');
    }

    poll(pads: readonly (Pad | null)[], foreground: boolean): void {
        this.foreground = foreground;
        const connected = pads.filter((pad): pad is Pad => Boolean(pad?.connected));
        this.devices = connected.map(pad => ({index: pad.index, id: pad.id}));
        if (this.autoSelect && connected.length) {
            this.selectedIndex = connected[0].index;
            this.autoSelect = false;
        }
        const pad = connected.find(item => item.index === this.selectedIndex) ?? null;
        if (!pad) {
            if (this.pad || this.input.isGamepadEnabled) this.unavailable('所选手柄已断开：已停止，请重新确认并启用');
            this.pad = null;
            this.enableHeld = false;
            this.report();
            return;
        }
        const identity = JSON.stringify([pad.index, pad.id, pad.mapping, pad.axes.length, pad.buttons.length]);
        if (identity !== this.identity) {
            this.disarm('已识别手柄，请观察轴值和按钮编号后确认映射');
            this.identity = identity;
            this.confirmed = false;
        }
        this.pad = pad;
        this.validation = validateMapping(this.mapping, pad);
        this.enableHeld = this.mapping.enableButton >= 0 && Boolean(pad.buttons[this.mapping.enableButton]?.pressed);
        if (!foreground) this.disarm('页面失焦或正在输入：手柄控制已关闭');
        if (this.validation || !this.confirmed) this.disarm(this.validation || '请先检测并确认映射');
        if (!this.input.isGamepadEnabled) {
            if (this.enabledPreviously) this.message = '手柄控制已关闭；回中并重新启用后才能操作';
            this.enabledPreviously = false;
            this.report();
            return;
        }
        if (!this.enabledPreviously) this.needsNeutral = true;
        this.enabledPreviously = true;
        const axis = (index: number, invert: boolean) => index < 0 ? 0 : pad.axes[index] * (invert ? -1 : 1);
        const x = axis(this.mapping.axisX, this.mapping.invertX);
        const y = axis(this.mapping.axisY, this.mapping.invertY);
        const down = (index: number) => index >= 0 && pad.buttons[index].pressed;
        const emergency = down(this.mapping.emergencyButton);
        if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1 || Math.abs(y) > 1) {
            this.disarm('手柄轴值异常：已停止');
        } else if (emergency) {
            this.input.emergencyStop();
            this.disarm('已发送急停：松开使能键并回中，然后重新启用手柄');
        } else {
            const horizontal = analogAxis(x);
            const longitudinal = -analogAxis(y);
            const left = down(this.mapping.leftButton), right = down(this.mapping.rightButton);
            const up = down(this.mapping.upButton), reverse = down(this.mapping.downButton);
            const buttonX = Number(right) - Number(left);
            const buttonY = Number(up) - Number(reverse);
            const conflict = (left && right) || (up && reverse) ||
                (horizontal !== 0 && buttonX !== 0 && Math.sign(horizontal) !== buttonX) ||
                (longitudinal !== 0 && buttonY !== 0 && Math.sign(longitudinal) !== buttonY);
            const steering = horizontal !== 0 ? horizontal : buttonX;
            const drive = longitudinal !== 0 ? longitudinal : buttonY;
            const centered = horizontal === 0 && longitudinal === 0 && !left && !right && !up && !reverse;
            if (this.needsNeutral) {
                this.input.updateGamepad('stop');
                if (!this.enableHeld && centered) {
                    this.needsNeutral = false;
                    this.lastDirection = 0;
                    this.message = '已就绪：按住使能键，摇杆幅度控制油门与转向';
                } else this.message = '等待回中：请松开使能键和所有方向键';
            } else if (conflict) {
                this.input.updateGamepad('stop');
                this.needsNeutral = true;
                this.message = '方向冲突：已停止，请松开使能键并回中';
            } else if (!this.enableHeld) {
                this.input.updateGamepad('stop');
                this.needsNeutral = !centered;
                if (centered) this.lastDirection = 0;
                this.message = centered ? '未按使能键：保持停止' : '已松开使能键：请先回中';
            } else if (drive !== 0 && this.lastDirection !== 0 && Math.sign(drive) !== this.lastDirection) {
                this.input.updateGamepad('stop');
                this.needsNeutral = true;
                this.message = '前后方向切换：已停止，请松开使能键并回中后重试';
            } else if (centered) {
                this.input.updateGamepad('stop');
                this.message = '摇杆回中：保持普通停止';
            } else {
                if (drive !== 0) this.lastDirection = Math.sign(drive);
                this.input.updateGamepad({mode: 'low_level', steering,
                    throttle: Math.abs(drive), brake: drive === 0 ? 1 : 0,
                    direction: drive > 0 ? 1 : drive < 0 ? -1 : 0});
                this.message = `比例请求：${drive < 0 ? '倒车' : drive > 0 ? '前进' : '保持挡位'} ` +
                    `油门 ${(Math.abs(drive) * 100).toFixed(1)}% · 转向 ${(steering * 100).toFixed(1)}%（相对车端上限，非执行确认）`;
            }
        }
        this.report();
    }
}

export function bindGamepadInput(monitor: GamepadInput, targetWindow: Window,
    targetDocument: Document, source: Pick<Navigator, 'getGamepads'>,
    controlToggles: readonly EventTarget[] = []): () => void {
    let timer: ReturnType<typeof setInterval> | undefined;
    const poll = () => {
        try {
            if (typeof source.getGamepads !== 'function') {
                monitor.unavailable('浏览器未提供手柄接口；请使用 HTTPS 或 localhost，并检查浏览器支持');
                return;
            }
            monitor.poll(Array.from(source.getGamepads()), !targetDocument.hidden &&
                targetDocument.hasFocus() && (controlToggles.includes(targetDocument.activeElement as EventTarget) ||
                    !isEditableTarget(targetDocument.activeElement)));
        } catch {
            monitor.unavailable('无法读取手柄；请检查 HTTPS、浏览器权限及设备连接');
        }
    };
    const start = () => {
        if (timer !== undefined) return;
        poll();
        timer = setInterval(poll, 50);
    };
    const stop = () => {
        if (timer !== undefined) clearInterval(timer);
        timer = undefined;
        monitor.unavailable('页面已离开：手柄控制已关闭');
    };
    const disconnected = (event: GamepadEvent) => monitor.disconnected(event.gamepad.index);
    targetWindow.addEventListener('gamepadconnected', poll);
    targetWindow.addEventListener('gamepaddisconnected', disconnected);
    targetWindow.addEventListener('pagehide', stop);
    targetWindow.addEventListener('pageshow', start);
    start();
    return () => {
        stop();
        targetWindow.removeEventListener('gamepadconnected', poll);
        targetWindow.removeEventListener('gamepaddisconnected', disconnected);
        targetWindow.removeEventListener('pagehide', stop);
        targetWindow.removeEventListener('pageshow', start);
    };
}
