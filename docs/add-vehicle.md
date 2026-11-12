# Register a vehicle

This guide covers server-side registration. Vehicle software installation,
camera configuration, and Apollo setup are delivered separately. A prepared
vehicle must be able to generate an enrollment machine code and complete
credential installation with this Gateway.

## Give the vehicle operator the endpoints

For the example LAN deployment:

- Gateway and console: `https://192.168.1.50:8443`
- Login service: `https://192.168.1.50:8444`
- Public CA certificate: `~/.local/state/teleop/root.crt` on the server

Replace the IP with the deployment's saved address. Transfer only the public
certificate over a trusted channel and compare its SHA-256 fingerprint with
the setup output. The vehicle must trust it inside the environment running its
software; host trust does not automatically configure a runtime container.
Never transfer the server's CA key, administrator password, or state directory.

The vehicle operator configures the Gateway/console endpoints, verifies HTTPS,
and runs the vehicle's bootstrap tool to obtain a machine code. Preserve any
existing device keys, credentials, and enrollment state during recovery.

## Approve in the dashboard

1. Sign in as an administrator and select the intended organization.
2. Open **车辆管理 → 注册车辆**.
3. Enter **车辆名称** and the **机器码** supplied by the vehicle operator.
4. Select **核对车辆** and confirm the device fingerprint and expiry with that
   operator. Approve only the intended device.
5. Select **确认注册车辆**. For recovery, use **确认恢复车辆**; recovery retains
   the original identity and organization.
6. Check **接入与邀请进度** until the vehicle has saved its credentials,
   verified authentication, and confirmed installation.

A code alone does not prove installation or healthy telemetry. If it expires,
the vehicle operator obtains a fresh code while preserving the device identity.
After activation, verify current telemetry and, separately, live camera frames.
Enrollment does not configure cameras or prove control readiness.

Assign human operator access through [Administration](auth-management.md) only
when appropriate. Native driving is blocked in this server release pending
handover support; a simulation acknowledgement is not physical handover.
