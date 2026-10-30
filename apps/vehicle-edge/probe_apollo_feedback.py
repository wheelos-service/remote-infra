"""Read-only check of feedback from a separate, running Apollo publisher."""

import argparse
import logging
import os
import time

os.environ["VEHICLE_CYBER_BACKEND"] = "apollo"

from vehicle_edge.cyber_bridge import CyberBridge, CyberOptions


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--timeout", type=float, default=8)
    args = parser.parse_args()
    if args.timeout <= 0:
        parser.error("--timeout must be positive")
    logging.basicConfig(level=logging.INFO)
    bridge = CyberBridge(CyberOptions(enabled=True, node_name=f"teleop_feedback_probe_{os.getpid()}"))
    bridge.start()
    try:
        deadline = time.monotonic() + args.timeout
        consecutive = 0
        while time.monotonic() < deadline:
            samples = bridge.snapshot()
            if all(kind in samples and samples[kind].age_ms <= 500
                   for kind in ("chassis", "localization")):
                consecutive += 1
                if consecutive >= 10:
                    bridge._chassis()
                    logging.info("[CYBER_PROBE] fresh chassis and localization for 1 second; source=%s",
                                 samples["chassis"].message.header.module_name)
                    return 0
            else:
                consecutive = 0
            time.sleep(0.1)
        logging.error("[CYBER_PROBE] feedback unavailable or stale: %s",
                      {kind: sample.age_ms for kind, sample in bridge.snapshot().items()})
        return 1
    finally:
        bridge.close()


if __name__ == "__main__":
    raise SystemExit(main())
