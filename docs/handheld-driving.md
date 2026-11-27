# Handheld driving quick reference

## Take control

1. Open the vehicle in **远程驾驶** and keep the driving tab focused. The first standard controller is selected automatically. If you replace the controller or edit its bindings, check **手柄检测与映射** and click **确认映射**.
2. When the receiver is online and all three camera feeds are ready, tap and release **RT** to request control. Click **请求接管（制动保持）** when it becomes available.
3. Wait for **车端已接管 REMOTE**, center both sticks, and release the mapped buttons. The controller activates automatically. Start driving when the dashboard shows **手柄输入就绪**. On wheel101, the expected status after takeover is **车端仲裁：REMOTE** with **底盘模式：COMPLETE_AUTO_DRIVE**. The button numbers under **手柄检测与映射** show what the browser sees even while driving input is in standby.

## Default controls

| Input | Action |
| --- | --- |
| **RT** (button 7) | Tap once to request control. During a session, a fresh tap starts handback. |
| **LT** (button 6) | At a standstill, center both sticks, release the D-pad, and tap to shift **N → D → R → N**. From **P**, the first tap requests **N**. Release LT between shifts. |
| Left stick left / right (axis 0) | Steer. More deflection gives more steering. |
| Right stick up (axis 3) | Apply proportional throttle. **D** drives forward, **R** drives backward, and **N** gives zero throttle. |
| Right stick down (axis 3) | Apply proportional service braking in any gear. Full down requests 100% braking. |
| D-pad up / down (buttons 12 / 13) | Full accelerator / full service brake. |
| D-pad left / right (buttons 14 / 15) | Full left / right steering with the steering stick centered. |
| **B** (button 1) or **Space** | Emergency stop. The dashboard button **急停（Space）** also works. |

Check **当前挡位** for the gear confirmed by the chassis. If a shift is missed, tap LT again. If the display shows **—**, wait for fresh feedback. Check behind the vehicle before reversing because all three cameras face forward. After a brief focus or video interruption, recenter the sticks and release the D-pad before driving again.

## Release control

Brake to a standstill, center the sticks, then tap **RT** or click **释放并等待车辆交接**. After an emergency stop or **停止并停用手柄**, complete handback before requesting a new session.

If **申请控制权** is greyed out, read the status. **等待车端撤销上一次控制** means the receiver is acknowledging revocation of the previous session. **上次控制已撤销，等待车辆确认已退出远程驾驶** means the vehicle is confirming it has left remote mode. The dashboard updates automatically, including after a browser refresh. If either message persists, check receiver connectivity and the vehicle’s Guardian and chassis status. [Handback troubleshooting](operations.md)
