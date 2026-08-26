# Tests

The tests are grouped by scope:

- `e2e_control_session_receiver.py` and `e2e_secure_receiver.py` are focused
  security and control-session checks.
- `e2e_qos_test.py` exercises LiveKit command delivery under simulated network
  loss and delay.
- `chaos_network.sh` is an optional manual network-chaos experiment; it is not
  required for the normal Demo startup.

The component unit tests remain next to their implementations under
`apps/teleop-gateway/internal/gateway/` and `apps/vehicle-edge/tests/`.
