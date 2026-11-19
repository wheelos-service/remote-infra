function toBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(binary);
}
function signMessage(payload) {
    const { command } = payload;
    const prefix = `${payload.version}|${payload.type}|${payload.session_id}|${payload.sequence}|${payload.timestamp_ms}|`;
    if (command.mode === 'high_level')
        return `${prefix}high_level|${command.action}`;
    return `${prefix}low_level|${command.steering}|${command.throttle}|${command.brake}|${command.direction ?? 1}`;
}
export class SecureControlSender {
    constructor({ gatewayBaseUrl, vehicleId, authToken, onRenewalError }) {
        this.renewAfterMs = 0;
        this.sequence = 0;
        this.sending = false;
        this.handoverPending = false;
        this.gatewayBaseUrl = gatewayBaseUrl.replace(/\/$/, '');
        this.vehicleId = vehicleId;
        this.authToken = authToken;
        this.onRenewalError = onRenewalError;
    }
    async createKeyPair() {
        const pair = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
        this.privateKey = pair.privateKey;
        this.publicKeyB64 = toBase64(await crypto.subtle.exportKey('raw', pair.publicKey));
    }
    async acquireSession() {
        if (this.handoverPending)
            throw new Error('Vehicle handover is pending; control reacquisition is blocked');
        const response = await fetch(`${this.gatewayBaseUrl}/api/vehicles/${encodeURIComponent(this.vehicleId)}/control/acquire`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.authToken}` },
            body: JSON.stringify({ public_key_b64: this.publicKeyB64 }),
        });
        if (!response.ok)
            throw new Error(`control session acquire failed: ${response.status}`);
        const data = await response.json();
        this.sessionId = data.session.session_id;
        this.renewAfterMs = data.renew_after_ms;
        return data;
    }
    setPublishData(publishData) {
        this.publishData = publishData;
    }
    startRenewal() {
        this.stopRenewal();
        this.renewTimer = setInterval(() => this.renew().catch(error => {
            this.stopRenewal();
            console.error('Control session renewal failed:', error);
            this.onRenewalError?.(error);
        }), this.renewAfterMs);
    }
    stopRenewal() {
        if (this.renewTimer)
            clearInterval(this.renewTimer);
        this.renewTimer = undefined;
    }
    async renew() {
        if (!this.sessionId)
            return;
        const response = await fetch(`${this.gatewayBaseUrl}/api/control/${this.sessionId}/renew`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.authToken}` },
        });
        if (!response.ok)
            throw new Error(`control session renew failed: ${response.status}`);
    }
    async release() {
        this.stopRenewal();
        if (!this.sessionId)
            return;
        const sessionId = this.sessionId;
        this.sessionId = undefined;
        this.handoverPending = true;
        const response = await fetch(`${this.gatewayBaseUrl}/api/control/${encodeURIComponent(sessionId)}/release`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${this.authToken}` },
            keepalive: true,
        });
        if (!response.ok && response.status !== 404)
            throw new Error(`control session release failed: ${response.status}`);
        if (response.status === 202) {
            throw new Error('Control release accepted; vehicle handover is NOT confirmed. Legacy v1 cannot confirm physical handover.');
        }
        this.handoverPending = false;
    }
    async sendCommand(command) {
        if (!this.privateKey || !this.sessionId || !this.publishData) {
            throw new Error('secure control sender is not initialized');
        }
        if (this.sending)
            return;
        this.sending = true;
        try {
            const payload = {
                version: 1,
                type: 'control',
                session_id: this.sessionId,
                sequence: ++this.sequence,
                timestamp_ms: Date.now(),
                command,
            };
            const signature = await crypto.subtle.sign('Ed25519', this.privateKey, new TextEncoder().encode(signMessage(payload)));
            if (this.sessionId !== payload.session_id)
                return;
            await this.publishData(JSON.stringify({ ...payload, signature: toBase64(signature) }));
        }
        finally {
            this.sending = false;
        }
    }
}
