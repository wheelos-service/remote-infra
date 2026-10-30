"""Entry point built together with Apollo's Cyber and Python 3.10 bindings."""

import os

os.environ["VEHICLE_CYBER_BACKEND"] = "apollo"

from vehicle_edge.vehicle_node import main

if __name__ == "__main__":
    main()
