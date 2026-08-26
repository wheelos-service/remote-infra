type ControlCommand = {
    mode: 'high_level' | 'low_level';
    action?: 'forward' | 'reverse' | 'left' | 'right' | 'stop' | 'emergency_stop';
    steering?: number;
    throttle?: number;
    brake?: number;
    direction?: -1 | 0 | 1;
};

type SenderOptions = {
    gatewayBaseUrl: string;
    vehicleId: string;
    authToken: string;
};

function toBase64(buffer: ArrayBuffer): string {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}

function signMessage(payload: { version: number; type: string; session_id: string; sequence: number; timestamp_ms: number; command: ControlCommand }): string {
    const {command} = payload;
    const prefix = `${payload.version}|${payload.type}|${payload.session_id}|${payload.sequence}|${payload.timestamp_ms}|`;
    if (command.mode === 'high_level') return `${prefix}high_level|${command.action}`;
    return `${prefix}low_level|${command.steering}|${command.throttle}|${command.brake}|${command.direction ?? 1}`;
}

export class SecureControlSender {
    private privateKey?: CryptoKey;
    private publicKeyB64?: string;
    private sessionId?: string;
    private renewAfterMs = 0;
    private renewTimer?: ReturnType<typeof setInterval>;
    private publishData?: (message: string) => Promise<void>;
    private sequence = 0;
    private readonly gatewayBaseUrl: string;
    private readonly vehicleId: string;
    private readonly authToken: string;

    constructor({gatewayBaseUrl, vehicleId, authToken}: SenderOptions) {
        this.gatewayBaseUrl = gatewayBaseUrl.replace(/\/$/, '');
        this.vehicleId = vehicleId;
        this.authToken = authToken;
    }

    async createKeyPair(): Promise<void> {
        const pair = await crypto.subtle.generateKey(
            {name: 'Ed25519'}, true, ['sign', 'verify']) as CryptoKeyPair;
        this.privateKey = pair.privateKey;
        this.publicKeyB64 = toBase64(await crypto.subtle.exportKey('raw', pair.publicKey));
    }

    async acquireSession(): Promise<{session: {session_id: string}; renew_after_ms: number}> {
        const response = await fetch(`${this.gatewayBaseUrl}/api/vehicles/${encodeURIComponent(this.vehicleId)}/control/acquire`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', Authorization: `Bearer ${this.authToken}`},
            body: JSON.stringify({public_key_b64: this.publicKeyB64}),
        });
        if (!response.ok) throw new Error(`control session acquire failed: ${response.status}`);
        const data = await response.json() as {session: {session_id: string}; renew_after_ms: number};
        this.sessionId = data.session.session_id;
        this.renewAfterMs = data.renew_after_ms;
        return data;
    }

    setPublishData(publishData: (message: string) => Promise<void>): void {
        this.publishData = publishData;
    }

    startRenewal(): void {
        this.stopRenewal();
        this.renewTimer = setInterval(() => this.renew().catch(console.error), this.renewAfterMs);
    }

    stopRenewal(): void {
        if (this.renewTimer) clearInterval(this.renewTimer);
        this.renewTimer = undefined;
    }

    async renew(): Promise<void> {
        if (!this.sessionId) return;
        const response = await fetch(`${this.gatewayBaseUrl}/api/control/${this.sessionId}/renew`, {
            method: 'POST',
            headers: {Authorization: `Bearer ${this.authToken}`},
        });
        if (!response.ok) throw new Error(`control session renew failed: ${response.status}`);
    }

    async release(): Promise<void> {
        this.stopRenewal();
        if (!this.sessionId) return;
        const sessionId = this.sessionId;
        this.sessionId = undefined;
        const response = await fetch(`${this.gatewayBaseUrl}/api/control/${encodeURIComponent(sessionId)}/release`, {
            method: 'POST',
            headers: {Authorization: `Bearer ${this.authToken}`},
            keepalive: true,
        });
        if (!response.ok && response.status !== 404) throw new Error(`control session release failed: ${response.status}`);
    }

    async sendCommand(command: ControlCommand): Promise<void> {
        if (!this.privateKey || !this.sessionId || !this.publishData) {
            throw new Error('secure control sender is not initialized');
        }
        const payload = {
            version: 1,
            type: 'control',
            session_id: this.sessionId,
            sequence: ++this.sequence,
            timestamp_ms: Date.now(),
            command,
        };
        const signature = await crypto.subtle.sign(
            'Ed25519', this.privateKey, new TextEncoder().encode(signMessage(payload)));
        await this.publishData(JSON.stringify({...payload, signature: toBase64(signature)}));
    }
}
