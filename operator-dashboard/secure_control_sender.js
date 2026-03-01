/*
 * Stage-1 secure command sender (browser side)
 * - Generates ephemeral Ed25519 key pair
 * - Registers public key via Go gateway
 * - Sends signed command packets with seq + ts
 */

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function arrayBufferToBase64(buf) {
  return bytesToBase64(new Uint8Array(buf));
}

function randomKeyId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return `kid-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

function buildSignMessage(payload) {
  return `${payload.vehicle_id}|${payload.key_id}|${payload.cmd}|${payload.val}|${payload.seq}|${payload.ts}`;
}

async function signString(privateKey, data) {
  const encoder = new TextEncoder();
  const sig = await crypto.subtle.sign("Ed25519", privateKey, encoder.encode(data));
  return arrayBufferToBase64(sig);
}

export class SecureControlSender {
  constructor({ gatewayBaseUrl, vehicleId, operatorId, authToken, dataChannel }) {
    this.gatewayBaseUrl = gatewayBaseUrl.replace(/\/$/, "");
    this.vehicleId = vehicleId;
    this.operatorId = operatorId;
    this.authToken = authToken;
    this.dataChannel = dataChannel;

    this.seq = 0;
    this.keyId = null;
    this.privateKey = null;
    this.publicKeyB64 = null;
  }

  async initEphemeralKey() {
    const pair = await crypto.subtle.generateKey(
      { name: "Ed25519" },
      true,
      ["sign", "verify"]
    );

    this.privateKey = pair.privateKey;
    const rawPub = await crypto.subtle.exportKey("raw", pair.publicKey);
    this.publicKeyB64 = arrayBufferToBase64(rawPub);
    this.keyId = randomKeyId();
  }

  async registerPublicKey(expiresInMs = 2 * 60 * 60 * 1000) {
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

    const resp = await fetch(`${this.gatewayBaseUrl}/api/keys/register`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
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

  async sendCommand(cmd, val) {
    if (!this.privateKey || !this.keyId) {
      throw new Error("SecureControlSender not initialized. Call registerPublicKey first.");
    }
    if (!this.dataChannel || this.dataChannel.readyState !== "open") {
      throw new Error("DataChannel is not open.");
    }

    this.seq += 1;
    const payload = {
      vehicle_id: this.vehicleId,
      key_id: this.keyId,
      cmd,
      val,
      seq: this.seq,
      ts: Date.now(),
    };

    const signMsg = buildSignMessage(payload);
    const sig = await signString(this.privateKey, signMsg);

    const packet = {
      ...payload,
      sig,
      alg: "Ed25519",
    };

    this.dataChannel.send(JSON.stringify(packet));
    return packet;
  }
}

/*
Example usage:

import { SecureControlSender } from './secure_control_sender.js';

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
