function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buf));
}

function randomKeyId(): string {
  if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) {
    return (crypto as any).randomUUID();
  }
  return `kid-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function buildSignMessage(payload: CommandPayload): string {
  return `${payload.vehicle_id}|${payload.key_id}|${payload.cmd}|${
      payload.val}|${payload.seq}|${payload.ts}`;
}

async function signString(
    privateKey: CryptoKey, data: string): Promise<string> {
  const encoder = new TextEncoder();
  const sig =
      await crypto.subtle.sign('Ed25519', privateKey, encoder.encode(data));
  return arrayBufferToBase64(sig);
}

export interface SecureControlSenderOptions {
  gatewayBaseUrl: string;
  vehicleId: string;
  operatorId: string;
  authToken: string;
  dataChannel: RTCDataChannel;
}

export interface CommandPayload {
  vehicle_id: string;
  key_id: string;
  cmd: string;
  val: number|string|boolean|null;
  seq: number;
  ts: number;
}

export interface SignedPacket extends CommandPayload {
  sig: string;
  alg: string;
}

export class SecureControlSender {
  gatewayBaseUrl: string;
  vehicleId: string;
  operatorId: string;
  authToken: string;
  dataChannel: RTCDataChannel;

  seq = 0;
  keyId: string|null = null;
  privateKey: CryptoKey|null = null;
  publicKeyB64: string|null = null;

  constructor(opts: SecureControlSenderOptions) {
    this.gatewayBaseUrl = opts.gatewayBaseUrl.replace(/\/$/, '');
    this.vehicleId = opts.vehicleId;
    this.operatorId = opts.operatorId;
    this.authToken = opts.authToken;
    this.dataChannel = opts.dataChannel;
  }

  async initEphemeralKey(): Promise<void> {
    const pair = await crypto.subtle.generateKey(
        {name: 'Ed25519'}, true, ['sign', 'verify']);

    this.privateKey = pair.privateKey;
    const rawPub = await crypto.subtle.exportKey('raw', pair.publicKey);
    this.publicKeyB64 = arrayBufferToBase64(rawPub);
    this.keyId = randomKeyId();
  }

  async registerPublicKey(expiresInMs = 2 * 60 * 60 * 1000): Promise<any> {
    if (!this.privateKey || !this.publicKeyB64 || !this.keyId) {
      await this.initEphemeralKey();
    }

    const body = {
      vehicle_id: this.vehicleId,
      operator_id: this.operatorId,
      key_id: this.keyId,
      public_key_b64: this.publicKeyB64,
      expires_at_ms: Date.now() + expiresInMs,
    };

    const resp = await fetch(`${this.gatewayBaseUrl}/api/v1/keys/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.authToken}`,
      },
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`registerPublicKey failed: ${resp.status} ${text}`);
    }

    return await resp.json();
  }

  async sendCommand(cmd: string, val: number|string|boolean|null):
      Promise<SignedPacket> {
    if (!this.privateKey || !this.keyId) {
      throw new Error(
          'SecureControlSender not initialized. Call registerPublicKey first.');
    }
    if (!this.dataChannel || this.dataChannel.readyState !== 'open') {
      throw new Error('DataChannel is not open.');
    }

    this.seq += 1;
    const payload: CommandPayload = {
      vehicle_id: this.vehicleId,
      key_id: this.keyId,
      cmd,
      val,
      seq: this.seq,
      ts: Date.now(),
    };

    const signMsg = buildSignMessage(payload);
    const sig = await signString(this.privateKey, signMsg);

    const packet: SignedPacket = {
      ...payload,
      sig,
      alg: 'Ed25519',
    };

    this.dataChannel.send(JSON.stringify(packet));
    return packet;
  }
}

/*
Example usage:

import { SecureControlSender } from './secure-control-sender';

const sender = new SecureControlSender({
  gatewayBaseUrl: 'https://teleop.your-domain.com',
  vehicleId: 'car-001',
  operatorId: 'driver-105',
  authToken: '<casdoor-jwt-or-dev-token>',
  dataChannel,
});

await sender.registerPublicKey();
await sender.sendCommand('steer', 50);
*/
