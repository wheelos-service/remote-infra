# Operator Console

This component is the standalone browser client for the remote vehicle
supervision Demo.

The HTML entrypoint is kept in `public/index.html`. The control sender
and video-grid modules live in `src/lib/` and are compiled to `dist` by the
build. The video-grid stylesheet lives in `public/css/video-grid.css` and is
copied into `dist`.

The `vehicle-state` module displays 5 Hz `vehicle.state` DataPackets alongside
video. It verifies the sending vehicle identity and envelope, discards reordered
packets, and marks missing/old telemetry stale independently of video. Control
feedback indicates middleware publication, never actuator acknowledgement.
Control messages use lossy `vehicle.control` packets addressed to the vehicle.
State snapshots use reliable delivery to support payloads above 1300 bytes.
For a monitor stuck waiting, inspect browser console `[STATE_ROOM]` for the
expected vehicle participant and `[STATE_RX]` for the first state packet's
sender, byte count and validation result. Packet contents and tokens are not logged.
The waiting monitor also displays target vehicle presence, total received data
packets, `vehicle.state` packet count and the last rejection reason. This helps
distinguish missing publication/delivery from rejected identity, topic or envelope.
Rebuild and hard-refresh the served `dist` page to load these diagnostics;
a page showing only the waiting heading is an older build or cached module.
RTC reconnect releases control; disconnect/connect to explicitly reacquire it.

Run `npm test` to build and exercise monitoring and command-signing behavior
with Node's built-in test runner (Node 22 or newer).

Goals:
- Run the UI as a static site for manual testing or in a browser kiosk.
- Make runtime configuration easy via URL query parameters so the page can be reused across environments.

Usage
-----

Run a simple static server and open the page with query parameters to set the operator client ID and endpoints.

Example (serve locally):

```bash
# from repo root
cd apps/operator-console
npm run build
python3 -m http.server 8000 --directory dist
# open in browser (the configured operator application client ID is the default):
# http://127.0.0.1:8000/
```

Query parameters
- `backend` - URL to Teleop Gateway (default: `https://gateway.wheelos.cn`)
- `livekit` - LiveKit server URL (default: `wss://rtc.wheelos.cn`)
- `casdoor` - Casdoor server base URL (default: `https://casdoor.wheelos.cn`)
- `clientId` - Casdoor operator application client ID (required)
- `org`, `app` - optional Casdoor display settings

The operator application must use authorization code + PKCE with redirect URI
`http://127.0.0.1:8000/` for this local static-server test. Do not put a client secret in the URL.

Keyboard control
----------------

After connecting as a Controller, check **启用键盘控制**. The checkbox is
disabled for Observers and until the control connection is ready. Keyboard input
always sends the existing high-level actions, independently of the mouse control
mode selector:

| Keys | Action |
| --- | --- |
| W / Arrow Up | Forward |
| S / Arrow Down | Reverse |
| A / Arrow Left | Left |
| D / Arrow Right | Right |
| Space | Emergency stop |

Hold a direction to send immediately and approximately every 100 ms; releasing
it sends `stop`. Different simultaneous directions send `stop` and require all
direction keys to be released before a new press. Space cancels repeating motion;
held keys cannot automatically resume it. Left/right retain the existing
high-level mapping with zero throttle; combined driving directions are not
supported. The status shows the command being sent, not a vehicle acknowledgment.

Keyboard control defaults to off. Window blur, hiding the page, entering an input
field, changing the command mode, or disabling the checkbox stops motion and
disarms keyboard input. Re-enable it explicitly after returning. A pointer press
on a direction button takes ownership and disarms the keyboard; keyboard and
pointer share one sending scheduler. Pointer release/cancellation stops motion,
including when released outside the original button. RTC reconnection releases the control session and disables input; disconnect/connect
to reacquire control, then explicitly enable keyboard or gamepad control again.
RTC disconnect, a command send failure, or lease renewal failure also disables
control; reconnect to retry.

Stop messages use the existing lossy data channel and may not be delivered on
disconnect. The vehicle watchdog remains the fallback. Keyboard changes do not
add physical actuation or a vehicle-side latched emergency stop.

Build and validate the frontend (Node.js 22+ recommended for the test runner):

```bash
npm test
```

Serve/deploy the entire newly built `dist/`, including `lib/control-input.js`;
no Gateway or vehicle changes are needed. For a manual check, connect to a test
vehicle, enable keyboard control, and observe `[CONTROL] apply cmd=remote` on
the vehicle while pressing/releasing W/A/S/D. Also check Space, W+A, switching
windows, typing in the vehicle-ID input, Observer mode, and reconnecting; none
should resume a held direction without explicit rearming/new input.

Gamepad detection and proportional control
------------------------------------------

Use HTTPS or localhost and press a controller button to allow Gamepad API
inspection. Select the intended device, check axes/buttons, confirm the mapping,
then enable **手柄识别与比例控制**. Defaults: left-stick horizontal axis 0 for steering, right-stick vertical axis 3
for forward/reverse throttle, LB/button 4
as held enable, B/button 1 as emergency; d-pad buttons 12–15. Mapping edits and
device changes invalidate confirmation. Disabled axes/buttons use -1.

Release enable and center the stick before arming. Hold enable to send normalized
`low_level` commands, sampled at 50 ms and published at approximately 100 ms.
Each axis has a 15% center deadzone. Outside it, signed effective travel is
`sign(value) * (abs(value) - 0.15) / 0.85`. For example raw 0.575 requests 50%
of the configured vehicle-side limit. Left-stick horizontal and right-stick vertical input combine in one low-level
packet, so forward/reverse propulsion and steering operate simultaneously.
Left-stick vertical (axis 1) and right-stick horizontal (axis 2) are ignored by
default. Buttons and keyboard bindings are unchanged. Nonstandard gamepads can
change the two mapped axis indices in the mapping panel. Matching d-pad
input supplies full travel when the corresponding stick axis is centered;
opposing inputs on one axis stop and require release/recentering.

Forward/backward selects DRIVE/REVERSE and throttle magnitude. Horizontal-only
input requests zero throttle, normal brake, and unchanged gear. Full recenter or
release of enable sends a distinct high-level normal stop immediately. A change
between forward and reverse first stops and requires enable release and full
recentering before retry; vehicle-side stopped-speed and gear-feedback guards
still apply. Emergency uses `emergency_stop` and disables the gamepad. None of
these safety commands wait for the normal movement timer or smoothing.

The status displays normalized requested percentages relative to vehicle limits,
not absolute actuator percentages or execution confirmation. The vehicle scales
throttle by the forward/reverse ceiling and steering by its steering ceiling;
vehicle-side throttle-rise and steering-rate limits smooth changes. Input amounts
no longer clip prematurely at the ceiling. Use the upgraded vehicle with this
frontend; an old vehicle would still clip rather than scale partial travel.

The shared sender keeps one in-flight publication and one replaceable pending
command; analog changes do not accumulate a queue. Release or emergency replaces
pending movement. The 200 ms sample-stall cutoff remains. Keyboard/pointer input
is mutually exclusive with gamepad input. Device loss, blur, page hiding, editing,
connection loss, mapping changes and invalid samples stop/disarm controls.
Reconnecting/restoring focus never resumes held movement automatically.

Validate with `npm test`, then use a real controller in simulation to check
partial/full travel, combined turning and propulsion, centering, enable release,
reversing, emergency, disconnection and window blur. Rebuild/deploy the entire
`dist/` including both input modules and CSS.

Six-camera front/rear views
---------------------------

The console automatically subscribes to all published vehicle tracks and keeps
all six attached while switching the displayed group. `adaptiveStream` is
explicitly disabled, so hiding a slot does not request a subscription pause.
Deploy the full rebuilt `dist/`, including `lib/camera-view.js` and the new CSS.

The front group uses `camera-left`, `camera-center`, `camera-right`; the rear
uses `camera-rear-left`, `camera-rear-center`, `camera-rear-right`. The existing
single `camera-front` (or legacy `camera`) feed remains supported. Labels always
identify physical front/rear and left/center/right; no mirroring is applied.
Only tracks from the selected vehicle identity are displayed.

The default **自动** view immediately selects rear for a reverse command and
front for a forward command through the shared keyboard/gamepad/pointer sender.
Low-level propulsion with explicit direction follows the same rule. Stop,
emergency stop, and steering-only input retain the current view. Fresh validated
chassis gear confirms the request; old DRIVE feedback cannot override a pending
reverse request. Observers follow fresh chassis gear without issuing commands.
A rejected/unconfirmed request remains labelled as a request, not a confirmed
gear change. Missing, neutral, or stale gear does not guess a new view.

The **前方 / 后方** options override display selection; returning to **自动**
uses the latest intent/gear. The current editable-field focus policy still
suspends keyboard/gamepad input when using this selector; explicitly re-enable
input after adjusting it. Both groups support center focus. Disconnect clears
all feeds, direction intent and manual overrides.

Each selected group retains three labelled slots even when a camera is absent.
A missing/unsubscribed track, media interruption, or more than two seconds
without a video frame displays a “无实时视频” cover, rather than substituting
another camera or leaving an unlabelled frozen view. Hidden tracks remain
subscribed; frame arrival for hidden elements may be throttled by the browser,
so a newly shown feed can remain covered until its next rendered frame.
Six feeds require six-camera capture/encoding capacity and sufficient bandwidth;
switching display groups does not reduce vehicle upload or browser subscriptions.
