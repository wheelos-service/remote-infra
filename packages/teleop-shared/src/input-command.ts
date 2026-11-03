export type VehicleAction = 'gear_park' | 'gear_neutral' | 'gear_drive' | 'gear_reverse' | 'auto_enter' | 'auto_exit';

export type ControlCommand = {
    mode: 'high_level' | 'low_level';
    action?: 'forward' | 'reverse' | 'left' | 'right' | 'stop' | 'emergency_stop' | VehicleAction;
    steering?: number;
    throttle?: number;
    brake?: number;
    direction?: -1 | 0 | 1;
};
