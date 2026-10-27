import type {ControlCommand} from './secure-control-sender.js';

const directions: Record<string, string> = {
    KeyW: 'forward', ArrowUp: 'forward',
    KeyS: 'reverse', ArrowDown: 'reverse',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
};

export const isControlKey = (code: string): boolean => code === 'Space' || code in directions;

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
};

/** One scheduler for pointer and keyboard input; no queued movement backlog. */
export class ControlInput {
    private available = false;
    private keyboardEnabled = false;
    private gamepadEnabled = false;
    private gamepadActive = false;
    private gamepadSampleAt = 0;
    private pressed = new Set<string>();
    private blocked = false;
    private pointerActive = false;
    private timer?: ReturnType<typeof setInterval>;
    private active?: ControlCommand;
    private pending?: ControlCommand;
    private sending = false;

    constructor(private readonly options: Options) {}

    get isKeyboardEnabled(): boolean { return this.keyboardEnabled; }
    get isGamepadEnabled(): boolean { return this.gamepadEnabled; }
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
        this.pointerActive = false;
        this.gamepadActive = false;
    }

    private dispatch(command: ControlCommand): void {
        if (!this.available) return;
        this.pending = command;
        if (!this.sending) void this.flush();
    }

    private async flush(): Promise<void> {
        this.sending = true;
        try {
            while (this.available && this.pending) {
                const command = this.pending;
                this.pending = undefined;
                await this.options.send(command);
            }
        } catch (error) {
            this.setAvailable(false);
            this.options.onError(error);
        } finally {
            this.sending = false;
        }
    }

    private start(command: ControlCommand, gamepad = false): void {
        this.clearMovement();
        this.active = command;
        this.gamepadActive = gamepad;
        this.dispatch(command);
        this.timer = setInterval(() => {
            if (this.gamepadActive && performance.now() - this.gamepadSampleAt > 200) {
                this.suspend('手柄采样超时：已停止，请重新启用');
                return;
            }
            if (this.active) this.dispatch(this.active);
        }, 100);
        this.report(`正在发送：${command.action ?? '低层控制'}（非车端执行确认）`);
    }

    setAvailable(available: boolean): void {
        this.clearMovement();
        this.pressed.clear();
        this.blocked = false;
        this.keyboardEnabled = false;
        this.gamepadEnabled = false;
        this.available = available;
        this.report(available ? '键盘控制未启用' : '控制不可用');
    }

    setKeyboardEnabled(enabled: boolean): void {
        if (!this.available) return;
        this.clearMovement();
        this.pressed.clear();
        this.blocked = false;
        this.keyboardEnabled = enabled;
        this.gamepadEnabled = false;
        this.dispatch({mode: 'high_level', action: 'stop'});
        this.report(enabled ? '键盘控制已启用，等待按键' : '键盘控制未启用');
    }

    suspend(message = '已停止；请重新启用键盘控制'): void {
        const wasActive = this.keyboardEnabled || this.gamepadEnabled || Boolean(this.active);
        const pendingSafety = this.pending?.action === 'stop' || this.pending?.action === 'emergency_stop'
            ? this.pending : undefined;
        this.clearMovement();
        this.pressed.clear();
        this.blocked = false;
        this.keyboardEnabled = false;
        this.gamepadEnabled = false;
        if (wasActive) this.dispatch({mode: 'high_level', action: 'stop'});
        else if (pendingSafety) this.dispatch(pendingSafety);
        this.report(message);
    }

    setGamepadEnabled(enabled: boolean): void {
        if (!this.available) return;
        this.suspend();
        this.gamepadEnabled = enabled;
        this.report(enabled ? '手柄已启用：先松开使能键并回中' : '手柄控制未启用');
    }

    updateGamepad(value: ControlCommand | 'forward' | 'reverse' | 'left' | 'right' | 'stop'): void {
        if (!this.available || !this.gamepadEnabled) return;
        this.gamepadSampleAt = performance.now();
        if (value === 'stop') {
            if (this.gamepadActive) {
                this.clearMovement();
                this.dispatch({mode: 'high_level', action: 'stop'});
                this.report('手柄已停止，等待使能键与摇杆输入');
            }
            return;
        }
        const command: ControlCommand = typeof value === 'string'
            ? {mode: 'high_level', action: value} : value;
        if (!this.gamepadActive) this.start(command, true);
        else {
            // Sample at 50 ms, transmit at 100 ms; retain only the newest value.
            this.active = command;
            if (this.pending) this.pending = command;
        }
    }

    keyDown(code: string, repeat = false): void {
        if (!this.available || !this.keyboardEnabled || !isControlKey(code) || repeat || this.pressed.has(code)) return;
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

    beginPointer(command: ControlCommand): void {
        if (!this.available) return;
        // A pointer takes ownership explicitly; held keys cannot resume it.
        this.keyboardEnabled = false;
        this.gamepadEnabled = false;
        this.pressed.clear();
        this.blocked = false;
        this.start(command);
        this.pointerActive = true;
    }

    endPointer(): void {
        if (!this.pointerActive) return;
        this.clearMovement();
        this.dispatch({mode: 'high_level', action: 'stop'});
        this.report('已发送停止；键盘控制未启用');
    }

    emergencyStop(): void {
        if (!this.available) return;
        this.gamepadEnabled = false;
        this.clearMovement();
        this.blocked = this.pressed.size > 0;
        this.dispatch({mode: 'high_level', action: 'emergency_stop'});
        this.report('已发送急停；松开按键并回中，手柄需重新启用');
    }
}

/** Bind browser lifecycle events separately from the command state machine. */
export function bindKeyboardInput(input: ControlInput, targetWindow: Window, targetDocument: Document,
    keyboardToggle?: EventTarget, gamepadToggle?: EventTarget): void {
    targetWindow.addEventListener('keydown', event => {
        if (!input.isKeyboardEnabled || !isControlKey(event.code)) return;
        if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing ||
            targetDocument.hidden || !targetDocument.hasFocus() || isEditableTarget(event.target)) return;
        event.preventDefault();
        input.keyDown(event.code, event.repeat);
    });
    targetWindow.addEventListener('keyup', event => {
        if (!isControlKey(event.code)) return;
        if (input.isKeyboardEnabled && !isEditableTarget(event.target)) event.preventDefault();
        input.keyUp(event.code);
    });
    targetWindow.addEventListener('blur', () => input.suspend('窗口失焦：已停止，请重新启用控制'));
    targetDocument.addEventListener('visibilitychange', () => {
        if (targetDocument.hidden) input.suspend('页面已隐藏：已停止，请重新启用控制');
    });
    targetDocument.addEventListener('focusin', event => {
        if (event.target !== keyboardToggle && event.target !== gamepadToggle && isEditableTarget(event.target)) {
            input.suspend('输入区域获得焦点：键盘与手柄控制已关闭');
        }
    });
    targetWindow.addEventListener('pointerup', () => input.endPointer());
    targetWindow.addEventListener('pointercancel', () => input.endPointer());
    targetWindow.addEventListener('lostpointercapture', () => input.endPointer());
}
