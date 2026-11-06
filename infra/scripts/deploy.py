#!/usr/bin/env python3
"""Public entry point for the managed deployment workflow."""
from pathlib import Path
import runpy

if __name__ == "__main__":
    workflow = runpy.run_path(str(Path(__file__).with_name("authentication-test.py")))
    workflow["main"]()
