export const vehicleActionKeys = {
    Digit1: 'gear_park', Digit2: 'gear_neutral', Digit3: 'gear_drive', Digit4: 'gear_reverse',
    KeyE: 'auto_enter', KeyQ: 'auto_exit',
};
export const vehicleActionLabels = {
    gear_park: 'P 驻车挡', gear_neutral: 'N 空挡', gear_drive: 'D 前进挡', gear_reverse: 'R 倒挡',
    auto_enter: '进入自动驾驶', auto_exit: '退出自动驾驶',
};
const directions = {
    KeyW: 'forward', ArrowUp: 'forward',
    KeyS: 'reverse', ArrowDown: 'reverse',
    KeyA: 'left', ArrowLeft: 'left',
    KeyD: 'right', ArrowRight: 'right',
};
export const isControlKey = (code) => code === 'Space' || code in directions || code in vehicleActionKeys;
export function isEditableTarget(target) {
    return Boolean(target?.closest?.('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"]'));
}
/** One scheduler for pointer and keyboard input; no queued movement backlog. */
export class ControlInput {
    constructor(options) {
        this.options = options;
        this.available = false;
        this.keyboardEnabled = false;
        this.gamepadEnabled = false;
        this.gamepadActive = false;
        this.gamepadSampleAt = 0;
        this.pressed = new Set();
        this.actionPressed = new Set();
        this.blocked = false;
        this.pointerActive = false;
        this.sending = false;
    }
    get isKeyboardEnabled() { return this.keyboardEnabled; }
    get isGamepadEnabled() { return this.gamepadEnabled; }
    get isAvailable() { return this.available; }
    report(message) {
        this.options.onChange({ available: this.available, keyboardEnabled: this.keyboardEnabled,
            gamepadEnabled: this.gamepadEnabled, message });
    }
    clearMovement() {
        if (this.timer !== undefined)
            clearInterval(this.timer);
        this.timer = undefined;
        this.active = undefined;
        this.pending = undefined;
        this.pointerActive = false;
        this.gamepadActive = false;
    }
    dispatch(command) {
        if (!this.available)
            return;
        this.pending = command;
        if (!this.sending)
            void this.flush();
    }
    async flush() {
        this.sending = true;
        try {
            while (this.available && this.pending) {
                const command = this.pending;
                this.pending = undefined;
                await this.options.send(command);
            }
        }
        catch (error) {
            this.setAvailable(false);
            this.options.onError(error);
        }
        finally {
            this.sending = false;
        }
    }
    start(command, gamepad = false) {
        this.clearMovement();
        this.active = command;
        this.gamepadActive = gamepad;
        this.dispatch(command);
        this.timer = setInterval(() => {
            if (this.gamepadActive && performance.now() - this.gamepadSampleAt > 200) {
                this.suspend('手柄采样超时：已停止，请重新启用');
                return;
            }
            if (this.active)
                this.dispatch(this.active);
        }, 100);
        this.report(`正在发送：${command.action ?? '低层控制'}（非车端执行确认）`);
    }
    setAvailable(available) {
        this.clearMovement();
        this.pressed.clear();
        this.actionPressed.clear();
        this.blocked = false;
        this.keyboardEnabled = false;
        this.gamepadEnabled = false;
        this.available = available;
        this.report(available ? '键盘控制未启用' : '控制不可用');
    }
    setKeyboardEnabled(enabled) {
        if (!this.available)
            return;
        this.clearMovement();
        this.pressed.clear();
        this.actionPressed.clear();
        this.blocked = false;
        this.keyboardEnabled = enabled;
        this.gamepadEnabled = false;
        this.dispatch({ mode: 'high_level', action: 'stop' });
        this.report(enabled ? '键盘控制已启用，等待按键' : '键盘控制未启用');
    }
    suspend(message = '已停止；请重新启用键盘控制') {
        const wasActive = this.keyboardEnabled || this.gamepadEnabled || Boolean(this.active);
        const pendingSafety = this.pending?.action === 'stop' || this.pending?.action === 'emergency_stop'
            ? this.pending : undefined;
        this.clearMovement();
        this.pressed.clear();
        this.actionPressed.clear();
        this.blocked = false;
        this.keyboardEnabled = false;
        this.gamepadEnabled = false;
        if (wasActive)
            this.dispatch({ mode: 'high_level', action: 'stop' });
        else if (pendingSafety)
            this.dispatch(pendingSafety);
        this.report(message);
    }
    setGamepadEnabled(enabled) {
        if (!this.available)
            return;
        this.suspend();
        this.gamepadEnabled = enabled;
        this.report(enabled ? '手柄已启用：先松开使能键并回中' : '手柄控制未启用');
    }
    updateGamepad(value) {
        if (!this.available || !this.gamepadEnabled)
            return;
        this.gamepadSampleAt = performance.now();
        if (value === 'stop') {
            if (this.gamepadActive) {
                this.clearMovement();
                this.dispatch({ mode: 'high_level', action: 'stop' });
                this.report('手柄已停止，等待使能键与摇杆输入');
            }
            return;
        }
        const command = typeof value === 'string'
            ? { mode: 'high_level', action: value } : value;
        if (!this.gamepadActive)
            this.start(command, true);
        else {
            // Sample at 50 ms, transmit at 100 ms; retain only the newest value.
            this.active = command;
            if (this.pending)
                this.pending = command;
        }
    }
    keyDown(code, repeat = false) {
        if (!this.available || !this.keyboardEnabled || !isControlKey(code) || repeat || this.pressed.has(code)
            || this.actionPressed.has(code))
            return;
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
        if (this.blocked)
            return;
        const actions = new Set([...this.pressed].map(key => directions[key]).filter(Boolean));
        if (actions.size > 1) {
            this.blocked = true;
            this.clearMovement();
            this.dispatch({ mode: 'high_level', action: 'stop' });
            this.report('方向键冲突：已发送停止，请松开全部方向键');
            return;
        }
        this.start({ mode: 'high_level', action: directions[code] });
    }
    keyUp(code) {
        if (code in vehicleActionKeys) {
            this.actionPressed.delete(code);
            return;
        }
        if (!this.pressed.delete(code))
            return;
        if (this.blocked) {
            if (this.pressed.size === 0) {
                this.blocked = false;
                this.report('已松键，等待重新按下方向键');
            }
            return;
        }
        if (this.pressed.size === 0) {
            this.clearMovement();
            this.dispatch({ mode: 'high_level', action: 'stop' });
            this.report('已发送停止，等待按键');
        }
    }
    beginPointer(command) {
        if (!this.available)
            return;
        // A pointer takes ownership explicitly; held keys cannot resume it.
        this.keyboardEnabled = false;
        this.gamepadEnabled = false;
        this.pressed.clear();
        this.blocked = false;
        this.start(command);
        this.pointerActive = true;
    }
    vehicleAction(action, pointer = false) {
        if (!this.available || !(action in vehicleActionLabels))
            return;
        if (this.options.allowVehicleActions === false) {
            this.suspend('当前协议未开放挡位/模式操作；已停止输入');
            return;
        }
        this.clearMovement();
        this.pressed.clear();
        this.blocked = false;
        if (pointer) {
            this.keyboardEnabled = false;
            this.gamepadEnabled = false;
        }
        this.dispatch({ mode: 'high_level', action });
        this.report(`已发送请求：${vehicleActionLabels[action]}；以底盘挡位/模式反馈为准`);
    }
    endPointer() {
        if (!this.pointerActive)
            return;
        this.clearMovement();
        this.dispatch({ mode: 'high_level', action: 'stop' });
        this.report('已发送停止；键盘控制未启用');
    }
    emergencyStop() {
        if (!this.available)
            return;
        this.gamepadEnabled = false;
        this.clearMovement();
        this.blocked = this.pressed.size > 0;
        this.dispatch({ mode: 'high_level', action: 'emergency_stop' });
        this.report('已发送急停；松开按键并回中，手柄需重新启用');
    }
}
/** Bind browser lifecycle events separately from the command state machine. */
export function bindKeyboardInput(input, targetWindow, targetDocument, keyboardToggle, gamepadToggle) {
    const keydown = (event) => {
        if (!input.isKeyboardEnabled || !isControlKey(event.code))
            return;
        if (event.altKey || event.ctrlKey || event.metaKey || event.isComposing ||
            targetDocument.hidden || !targetDocument.hasFocus() || isEditableTarget(event.target))
            return;
        event.preventDefault();
        input.keyDown(event.code, event.repeat);
    };
    const keyup = (event) => {
        if (!isControlKey(event.code))
            return;
        if (input.isKeyboardEnabled && !isEditableTarget(event.target))
            event.preventDefault();
        input.keyUp(event.code);
    };
    const blur = () => input.suspend('窗口失焦：已停止，请重新启用控制');
    const visibility = () => {
        if (targetDocument.hidden)
            input.suspend('页面已隐藏：已停止，请重新启用控制');
    };
    const focus = (event) => {
        if (event.target !== keyboardToggle && event.target !== gamepadToggle && isEditableTarget(event.target)) {
            input.suspend('输入区域获得焦点：键盘与手柄控制已关闭');
        }
    };
    const endPointer = () => input.endPointer();
    targetWindow.addEventListener('keydown', keydown);
    targetWindow.addEventListener('keyup', keyup);
    targetWindow.addEventListener('blur', blur);
    targetDocument.addEventListener('visibilitychange', visibility);
    targetDocument.addEventListener('focusin', focus);
    targetWindow.addEventListener('pointerup', endPointer);
    targetWindow.addEventListener('pointercancel', endPointer);
    targetWindow.addEventListener('lostpointercapture', endPointer);
    return () => {
        input.suspend('输入组件已关闭');
        input.setAvailable(false);
        targetWindow.removeEventListener('keydown', keydown);
        targetWindow.removeEventListener('keyup', keyup);
        targetWindow.removeEventListener('blur', blur);
        targetDocument.removeEventListener('visibilitychange', visibility);
        targetDocument.removeEventListener('focusin', focus);
        targetWindow.removeEventListener('pointerup', endPointer);
        targetWindow.removeEventListener('pointercancel', endPointer);
        targetWindow.removeEventListener('lostpointercapture', endPointer);
    };
}
