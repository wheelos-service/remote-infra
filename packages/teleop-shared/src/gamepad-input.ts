import {ControlInput, isEditableTarget} from './control-input.js';
import {TELEOP_TIMING} from './control-timing.js';

export const vehicleActionButtons = {
    parkButton: 'gear_park', gearCycleButton: 'cycle_gear', autoEnterButton: 'auto_enter', autoExitButton: 'auto_exit',
} as const;

const nextGearAction = {P: 'gear_neutral', N: 'gear_drive', D: 'gear_reverse', R: 'gear_neutral'} as const;
type TriggerControls = {
    standardMapping?: GamepadMapping;
    currentGear?: () => keyof typeof nextGearAction | undefined;
    toggleControl?: () => void;
    canDrive?: () => boolean;
};

export type GamepadMapping = {
    axisX: number; axisY: number; invertX: boolean; invertY: boolean;
    emergencyButton: number;
    upButton: number; downButton: number; leftButton: number; rightButton: number;
    gearCycleButton: number; requestControlButton: number;
    parkButton: number; autoEnterButton: number; autoExitButton: number;
};

export const defaultGamepadMapping: GamepadMapping = {
    axisX: 0, axisY: 3, invertX: false, invertY: false,
    emergencyButton: 1,
    upButton: 12, downButton: 13, leftButton: 14, rightButton: 15,
    gearCycleButton: 6, requestControlButton: 7,
    parkButton: 0,
    autoEnterButton: 9, autoExitButton: 8,
};

export type Pad = Pick<Gamepad, 'index' | 'id' | 'mapping' | 'axes' | 'buttons' | 'connected'>;
export type GamepadView = {
    devices: {index: number; id: string}[];
    selectedIndex: number | null;
    pad: Pad | null;
    confirmed: boolean;
    message: string;
    validation: string;
};

export function validateMapping(mapping: GamepadMapping, pad: Pad): string {
    const axes = [mapping.axisX, mapping.axisY];
    const directions = [mapping.upButton, mapping.downButton, mapping.leftButton, mapping.rightButton];
    const actions = Object.keys(vehicleActionButtons).map(key => mapping[key as keyof typeof vehicleActionButtons]);
    actions.push(mapping.requestControlButton);
    const buttons = [mapping.emergencyButton, ...directions, ...actions];
    if (axes.some(index => !Number.isInteger(index) || index < -1 || index >= pad.axes.length) ||
        directions.some(index => !Number.isInteger(index) || index < -1) ||
        actions.some(index => !Number.isInteger(index) || index < -1) ||
        !Number.isInteger(mapping.emergencyButton) || mapping.emergencyButton < 0 ||
        buttons.some(index => index >= pad.buttons.length)) return '映射编号超出当前手柄范围；不用的轴/方向键请填 -1';
    const enabledAxes = axes.filter(index => index >= 0);
    const enabledButtons = buttons.filter(index => index >= 0);
    if (new Set(enabledAxes).size !== enabledAxes.length ||
        new Set(enabledButtons).size !== enabledButtons.length) return '映射编号不能重复';
    if (!enabledAxes.length && !directions.some(index => index >= 0)) return '至少配置一个方向轴或方向按钮';
    return '';
}

export function analogAxis(value: number): number {
    const magnitude = Math.abs(value);
    return magnitude <= 0.15 ? 0 : Math.sign(value) * (magnitude - 0.15) / 0.85;
}

/** Only accept new driving input after a neutral sample from the selected, confirmed pad. */
export class GamepadInput {
    private selectedIndex: number | null = null;
    private autoSelect = true;
    private identity = '';
    private mapping: GamepadMapping;
    private confirmed = false;
    private pad: Pad | null = null;
    private devices: GamepadView['devices'] = [];
    private needsNeutral = true;
    private message = '等待连接手柄';
    private validation = '';
    private previousActions = new Set<(typeof vehicleActionButtons)[keyof typeof vehicleActionButtons]>();
    private requestHeld = true;

    constructor(private readonly input: ControlInput, private readonly onView: (view: GamepadView) => void,
        private readonly propulsionDirection: () => -1 | 0 | 1 = () => 0,
        private readonly supportsDriving: () => boolean = () => true,
        private readonly triggers: TriggerControls = {}) {
        this.mapping = triggers.standardMapping ?? defaultGamepadMapping;
    }

    private report(): void {
        this.onView({devices: this.devices, selectedIndex: this.selectedIndex, pad: this.pad,
            confirmed: this.confirmed, message: this.message,
            validation: this.validation,
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
        this.requestHeld = true;
        this.confirmed = false;
        this.validation = this.pad ? validateMapping(this.mapping, this.pad) : '';
        this.report();
    }

    confirmMapping(confirmed: boolean): void {
        this.disarm(confirmed ? '映射已确认' : '请先检测并确认映射');
        this.requestHeld = true;
        this.confirmed = Boolean(confirmed && this.pad && !validateMapping(this.mapping, this.pad));
        this.report();
    }

    private disarm(message: string): void {
        if (this.input.isGamepadEnabled) this.input.suspend(message);
        this.needsNeutral = true;
        this.message = message;
    }

    unavailable(message: string): void {
        this.disarm(message);
        this.pad = null;
        this.devices = [];
        this.confirmed = false;
        this.identity = '';
        this.report();
    }

    resetTriggerEdge(): void {
        // Browsers can suspend polling in the background and miss the start of a press.
        this.requestHeld = true;
    }

    disconnected(index: number): void {
        if (index === this.selectedIndex) this.unavailable('手柄已断开：已停止，重连后需重新确认映射');
    }

    poll(pads: readonly (Pad | null)[], foreground: boolean): void {
        const connected = pads.filter((pad): pad is Pad => Boolean(pad?.connected));
        this.devices = connected.map(pad => ({index: pad.index, id: pad.id}));
        const firstConnection = this.autoSelect && connected.length > 0;
        if (firstConnection) {
            this.selectedIndex = connected[0].index;
            this.autoSelect = false;
        }
        const pad = connected.find(item => item.index === this.selectedIndex) ?? null;
        if (!pad) {
            if (this.pad || this.input.isGamepadEnabled) this.unavailable('所选手柄已断开：已停止，请重新确认映射');
            this.pad = null;
            this.report();
            return;
        }
        const identity = JSON.stringify([pad.index, pad.id, pad.mapping, pad.axes.length, pad.buttons.length]);
        if (identity !== this.identity) {
            this.disarm('已识别手柄，请观察轴值和按钮编号后确认映射');
            this.identity = identity;
            this.confirmed = Boolean(firstConnection && this.mapping === this.triggers.standardMapping && pad.mapping === 'standard' &&
                !validateMapping(this.mapping, pad));
            this.requestHeld = true;
        }
        this.pad = pad;
        const actions = Object.entries(vehicleActionButtons)
            .filter(([key]) => {
                const index = this.mapping[key as keyof typeof vehicleActionButtons];
                return index >= 0 && Boolean(pad.buttons[index]?.pressed);
            }).map(([, action]) => action);
        const freshActions = actions.filter(action => !this.previousActions.has(action));
        this.previousActions = new Set(actions);
        const requestPressed = Boolean(pad.buttons[this.mapping.requestControlButton]?.pressed);
        const freshRequest = requestPressed && !this.requestHeld;
        this.requestHeld = requestPressed;
        this.validation = validateMapping(this.mapping, pad);
        if (!foreground || this.validation || !this.confirmed) {
            this.disarm(!foreground ? '手柄输入已暂停：页面失焦或正在编辑' : this.validation || '等待确认手柄映射');
            this.report();
            return;
        }
        const down = (index: number) => index >= 0 && pad.buttons[index].pressed;
        const emergency = down(this.mapping.emergencyButton);
        const axis = (index: number, invert: boolean) => index < 0 ? 0 : pad.axes[index] * (invert ? -1 : 1);
        const x = axis(this.mapping.axisX, this.mapping.invertX);
        const y = axis(this.mapping.axisY, this.mapping.invertY);
        if (emergency && this.input.isAvailable) {
            if (!this.input.isEmergencyLatched) this.input.emergencyStop();
            this.disarm('紧急制动已触发');
        } else if (requestPressed) {
            this.disarm('会话按钮已按下');
            if (freshRequest && actions.length === 0 && !emergency) this.triggers.toggleControl?.();
        } else if (!this.input.isAvailable || this.input.isKeyboardEnabled || this.input.isEmergencyLatched ||
            this.triggers.canDrive?.() === false) {
            this.disarm('手柄驾驶未就绪');
        } else if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 1 || Math.abs(y) > 1) {
            this.disarm('手柄轴值异常：已停止');
        } else if (!this.supportsDriving()) {
            this.disarm('车端未开放挡位与行车制动；手柄仅可急停');
        } else {
            const horizontal = analogAxis(x);
            const longitudinal = -analogAxis(y);
            const left = down(this.mapping.leftButton), right = down(this.mapping.rightButton);
            const up = down(this.mapping.upButton), brakeButton = down(this.mapping.downButton);
            const buttonX = Number(right) - Number(left);
            const buttonY = Number(up) - Number(brakeButton);
            const conflict = (left && right) || (up && brakeButton) ||
                (horizontal !== 0 && buttonX !== 0 && Math.sign(horizontal) !== buttonX) ||
                (longitudinal !== 0 && buttonY !== 0 && Math.sign(longitudinal) !== buttonY);
            const steering = horizontal !== 0 ? horizontal : buttonX;
            const drive = buttonY || longitudinal;
            const centered = horizontal === 0 && longitudinal === 0 && !left && !right && !up && !brakeButton;
            if (this.needsNeutral || !this.input.isGamepadEnabled) {
                this.input.updateGamepad('stop');
                if (centered && actions.length === 0) {
                    if (!this.input.isGamepadEnabled) this.input.setGamepadEnabled(true);
                    this.needsNeutral = false;
                    this.message = '手柄已就绪';
                } else this.message = '等待摇杆回中和按钮释放';
            } else if (actions.length > 0) {
                if (centered && actions.length === 1 && freshActions.length === 1) {
                    const pressed = freshActions[0];
                    const gear = this.triggers.currentGear?.();
                    const action = pressed === 'cycle_gear' ? (gear && nextGearAction[gear]) : pressed;
                    if (action) {
                        this.input.vehicleAction(action);
                        this.message = '请求已发送，等待松键回中';
                    } else {
                        this.input.updateGamepad('stop');
                        this.message = '底盘挡位未知；等待新反馈，松键回中后重试';
                    }
                } else {
                    this.input.updateGamepad('stop');
                    this.message = '挡位或模式请求冲突，等待松键回中';
                }
                this.needsNeutral = true;
            } else if (conflict) {
                this.input.updateGamepad('stop');
                this.needsNeutral = true;
                this.message = '方向冲突：已停止，等待回中';
            } else if (centered) {
                this.input.updateGamepad('stop');
                this.message = '摇杆回中：保持普通停止';
            } else {
                const direction = drive > 0 ? this.propulsionDirection() : 0;
                const throttle = direction === 0 ? 0 : drive;
                const brake = Math.max(0, -drive);
                this.input.updateGamepad({mode: 'low_level', steering, throttle, brake, direction});
                this.message = `油门 ${(throttle * 100).toFixed(1)}% · 行车制动 ${(brake * 100).toFixed(1)}% · 转向 ${(steering * 100).toFixed(1)}%`;
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
        timer = setInterval(poll, TELEOP_TIMING.gamepadPollMs);
    };
    const stop = () => {
        if (timer !== undefined) clearInterval(timer);
        timer = undefined;
        monitor.unavailable('页面已离开：手柄控制已关闭');
    };
    const disconnected = (event: GamepadEvent) => monitor.disconnected(event.gamepad.index);
    const resetTrigger = () => monitor.resetTriggerEdge();
    targetWindow.addEventListener('focus', resetTrigger);
    targetDocument.addEventListener('visibilitychange', resetTrigger);
    targetWindow.addEventListener('gamepadconnected', poll);
    targetWindow.addEventListener('gamepaddisconnected', disconnected);
    targetWindow.addEventListener('pagehide', stop);
    targetWindow.addEventListener('pageshow', start);
    start();
    return () => {
        stop();
        targetWindow.removeEventListener('focus', resetTrigger);
        targetDocument.removeEventListener('visibilitychange', resetTrigger);
        targetWindow.removeEventListener('gamepadconnected', poll);
        targetWindow.removeEventListener('gamepaddisconnected', disconnected);
        targetWindow.removeEventListener('pagehide', stop);
        targetWindow.removeEventListener('pageshow', start);
    };
}
