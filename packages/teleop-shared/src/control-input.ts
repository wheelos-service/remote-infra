import type {ControlCommand, VehicleAction} from './input-command.js';
import {TELEOP_TIMING} from './control-timing.js';

export const vehicleActionKeys: Readonly<Record<string, VehicleAction>> = {
    Digit1: 'gear_park', Digit2: 'gear_neutral', Digit3: 'gear_drive', Digit4: 'gear_reverse',
    KeyE: 'auto_enter', KeyQ: 'auto_exit',
};
export const vehicleActionLabels: Record<VehicleAction, string> = {
    gear_park: 'P 驻车挡', gear_neutral: 'N 空挡', gear_drive: 'D 前进挡', gear_reverse: 'R 倒挡',
    auto_enter: '进入自动驾驶', auto_exit: '退出自动驾驶',
};

const directions: Record<string, string> = {
    KeyW: 'forward', ArrowUp: 'forward',
    KeyS: 'reverse', ArrowDown: 'reverse',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
};

export const isControlKey = (code: string): boolean => code === 'Space' || code in directions || code in vehicleActionKeys;

export function isEditableTarget(target: EventTarget | null): boolean {
    return Boolean((target as Element | null)?.closest?.(
        'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]',
    ));
}

type InputState = {available: boolean; keyboardEnabled: boolean; gamepadEnabled: boolean; message: string};
type Options = {
    send: (command: ControlCommand) => Promise<void>;
    onChange: (state: InputState) => void;
    onError: (error: unknown) => void;
    allowVehicleActions?: boolean;
};

/** One scheduler for keyboard and gamepad input; no queued movement backlog. */
export class ControlInput {
    private available = false;
    private keyboardEnabled = false;
    private gamepadEnabled = false;
    private gamepadActive = false;
    private gamepadSampleAt = 0;
    private pressed = new Set<string>();
    private actionPressed = new Set<string>();
    private blocked = false;
    private timer?: ReturnType<typeof setInterval>;
    private active?: ControlCommand;
    private pending?: ControlCommand;
    private sending = false;
    private sendingTask?: Promise<void>;
    private emergencySending = false;
    private emergencyLatched = false;

    constructor(private readonly options: Options) {}

    get isKeyboardEnabled(): boolean { return this.keyboardEnabled; }
    get isGamepadEnabled(): boolean { return this.gamepadEnabled; }
    get isEmergencyLatched(): boolean { return this.emergencyLatched; }
    get isAvailable(): boolean { return this.available; }

    private report(message: string): void {
        this.options.onChange({available: this.available, keyboardEnabled: this.keyboardEnabled,
            gamepadEnabled: this.gamepadEnabled, message});
    }

    private clearMovement(): void {
        if (this.timer !== undefined) clearInterval(this.timer);
        this.timer = undefined;
        this.active = undefined;
        this.pending = undefined;
        this.gamepadActive = false;
    }

    private dispatch(command: ControlCommand): void {
        if (!this.available) return;
        this.pending = command;
        if (!this.sending) {
            this.sendingTask = this.flush();
            void this.sendingTask;
        }
    }

    private async flush(): Promise<void> {
        this.sending = true;
        try {
            while (this.available && this.pending) {
                const command = this.pending;
                this.pending = undefined;
                this.emergencySending = command.action === 'emergency_stop';
                try { await this.options.send(command); }
                finally { this.emergencySending = false; }
            }
        } catch (error) {
            this.setAvailable(false);
            this.options.onError(error);
        } finally {
            this.sending = false;
            this.sendingTask = undefined;
        }
    }

    private start(command: ControlCommand, gamepad = false): void {
        this.clearMovement();
        this.active = command;
        this.gamepadActive = gamepad;
        if (command.action !== 'emergency_stop') this.emergencyLatched = false;
        this.dispatch(command);
        this.timer = setInterval(() => {
            if (this.gamepadActive && performance.now() - this.gamepadSampleAt > TELEOP_TIMING.gamepadSampleTimeoutMs) {
                this.suspend('手柄采样超时：已停止');
                return;
            }
            if (this.active) this.dispatch(this.active);
        }, TELEOP_TIMING.inputRepeatMs);
        this.report(`正在发送：${command.action ?? '低层控制'}（非车端执行确认）`);
    }

    setAvailable(available: boolean): void {
        this.clearMovement();
        this.pressed.clear();
        this.actionPressed.clear();
        this.blocked = false;
        this.keyboardEnabled = false;
        this.gamepadEnabled = false;
        this.emergencyLatched = false;
        this.available = available;
        this.report(available ? '控制会话已就绪' : '控制不可用');
    }

    setKeyboardEnabled(enabled: boolean): void {
        if (!this.available) return;
        this.clearMovement();
        this.pressed.clear();
        this.actionPressed.clear();
        this.blocked = false;
        this.keyboardEnabled = enabled;
        this.gamepadEnabled = false;
        if (enabled) this.emergencyLatched = false;
        this.dispatch({mode: 'high_level', action: this.emergencyLatched ? 'emergency_stop' : 'stop'});
        this.report(enabled ? '键盘控制已启用，等待按键' : '键盘控制未启用');
    }

    suspend(message = '驾驶输入已暂停'): void {
        const wasActive = this.keyboardEnabled || this.gamepadEnabled || Boolean(this.active);
        const pendingSafety = this.pending?.action === 'emergency_stop'
            ? this.pending : this.emergencySending || this.emergencyLatched
                ? {mode: 'high_level', action: 'emergency_stop'} as const :
                this.pending?.action === 'stop' ? this.pending : undefined;
        this.clearMovement();
        this.pressed.clear();
        this.actionPressed.clear();
        this.blocked = false;
        this.keyboardEnabled = false;
        this.gamepadEnabled = false;
        if (wasActive) this.dispatch(pendingSafety ?? {mode: 'high_level', action: 'stop'});
        else if (pendingSafety) this.dispatch(pendingSafety);
        this.report(message);
    }

    async suspendAndWait(message = '驾驶输入已暂停'): Promise<void> {
        this.suspend(message);
        await this.sendingTask;
    }

    setGamepadEnabled(enabled: boolean): void {
        if (!this.available) return;
        this.suspend();
        if (enabled) this.emergencyLatched = false;
        this.gamepadEnabled = enabled;
        this.report(enabled ? '手柄输入就绪' : '手柄输入待命');
    }

    updateGamepad(value: ControlCommand | 'forward' | 'reverse' | 'left' | 'right' | 'stop'): void {
        if (!this.available || !this.gamepadEnabled) return;
        this.gamepadSampleAt = performance.now();
        if (value === 'stop') {
            if (this.gamepadActive) {
                this.clearMovement();
                this.dispatch({mode: 'high_level', action: 'stop'});
                this.report('手柄已停止');
            }
            return;
        }
        const command: ControlCommand = typeof value === 'string'
            ? {mode: 'high_level', action: value} : value;
        if (!this.gamepadActive) this.start(command, true);
        else {
            // Polling supplies fresh samples; the shared repeat timer retains only the newest value.
            this.active = command;
            if (this.pending) this.pending = command;
        }
    }

    keyDown(code: string, repeat = false): void {
        if (!this.available || !this.keyboardEnabled || !isControlKey(code) || repeat || this.pressed.has(code)
            || this.actionPressed.has(code)) return;
        if (code in vehicleActionKeys) {
            this.vehicleAction(vehicleActionKeys[code]);
            this.actionPressed.add(code);
            return;
        }
        this.pressed.add(code);
        if (code === 'Space') {
            this.emergencyStop();
            return;
        }
        if (this.blocked) return;
        const actions = new Set([...this.pressed].map(key => directions[key]).filter(Boolean));
        if (actions.size > 1) {
            this.blocked = true;
            this.clearMovement();
            this.dispatch({mode: 'high_level', action: 'stop'});
            this.report('方向键冲突：已发送停止，请松开全部方向键');
            return;
        }
        this.start({mode: 'high_level', action: directions[code] as ControlCommand['action']});
    }

    keyUp(code: string): void {
        if (code in vehicleActionKeys) {
            this.actionPressed.delete(code);
            return;
        }
        if (!this.pressed.delete(code)) return;
        if (this.blocked) {
            if (this.pressed.size === 0) {
                this.blocked = false;
                this.report('已松键，等待重新按下方向键');
            }
            return;
        }
        if (this.pressed.size === 0) {
            this.clearMovement();
            this.dispatch({mode: 'high_level', action: 'stop'});
            this.report('已发送停止，等待按键');
        }
    }

    vehicleAction(action: VehicleAction): void {
        if (!this.available || !(action in vehicleActionLabels)) return;
        if (this.options.allowVehicleActions === false) {
            this.suspend('当前协议未开放挡位/模式操作；已停止输入');
            return;
        }
        this.clearMovement();
        this.pressed.clear();
        this.blocked = false;
        this.dispatch({mode: 'high_level', action});
        this.report(`已发送请求：${vehicleActionLabels[action]}；以底盘挡位/模式反馈为准`);
    }

    emergencyStop(): void {
        if (!this.available) return;
        this.emergencyLatched = true;
        this.keyboardEnabled = false;
        this.gamepadEnabled = false;
        this.clearMovement();
        this.blocked = this.pressed.size > 0;
        this.dispatch({mode: 'high_level', action: 'emergency_stop'});
        this.report('已发送急停');
    }
}

/** Bind browser lifecycle events separately from the command state machine. */
export type InputInterruption = 'window_blur' | 'window_focus' | 'page_hidden' | 'page_visible' | 'editable_focus';

export function bindKeyboardInput(input: ControlInput, targetWindow: Window, targetDocument: Document,
    keyboardToggle?: EventTarget, gamepadToggle?: EventTarget,
    onInterruption?: (event: InputInterruption) => void,
    onEmergencyStop?: () => void): () => void {
    const keydown = (event: KeyboardEvent) => {
        if (!isControlKey(event.code)) return;
        if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing ||
            targetDocument.hidden || !targetDocument.hasFocus() || isEditableTarget(event.target)) return;
        if (event.code === 'Space') {
            if (input.isKeyboardEnabled) {
                event.preventDefault();
                input.keyDown(event.code, event.repeat);
            } else if (!event.repeat && onEmergencyStop) {
                event.preventDefault();
                onEmergencyStop();
            }
            return;
        }
        if (!input.isKeyboardEnabled) return;
        event.preventDefault();
        input.keyDown(event.code, event.repeat);
    };
    const keyup = (event: KeyboardEvent) => {
        if (!isControlKey(event.code)) return;
        if (input.isKeyboardEnabled && !isEditableTarget(event.target)) event.preventDefault();
        input.keyUp(event.code);
    };
    const blur = () => {
        input.suspend('窗口失焦：驾驶输入已暂停');
        onInterruption?.('window_blur');
    };
    const focus = () => onInterruption?.('window_focus');
    const visibility = () => {
        if (targetDocument.hidden) {
            input.suspend('页面已隐藏：驾驶输入已暂停');
            onInterruption?.('page_hidden');
        } else onInterruption?.('page_visible');
    };
    const focusin = (event: FocusEvent) => {
        if (event.target !== keyboardToggle && event.target !== gamepadToggle && isEditableTarget(event.target)) {
            input.suspend('输入区域获得焦点：键盘与手柄控制已关闭');
            onInterruption?.('editable_focus');
        }
    };
    targetWindow.addEventListener('keydown', keydown);
    targetWindow.addEventListener('keyup', keyup);
    targetWindow.addEventListener('blur', blur);
    targetWindow.addEventListener('focus', focus);
    targetDocument.addEventListener('visibilitychange', visibility);
    targetDocument.addEventListener('focusin', focusin);
    return () => {
        void input.suspendAndWait('输入组件已关闭').finally(() => input.setAvailable(false));
        targetWindow.removeEventListener('keydown', keydown);
        targetWindow.removeEventListener('keyup', keyup);
        targetWindow.removeEventListener('blur', blur);
        targetWindow.removeEventListener('focus', focus);
        targetDocument.removeEventListener('visibilitychange', visibility);
        targetDocument.removeEventListener('focusin', focusin);
    };
}
