#!/usr/bin/env python3
"""Render Compose service configuration without shell interpolation of secrets."""
import json
import os
from pathlib import Path
import re
import sys


def render(kind, template, environment):
    if kind == "livekit":
        names = ("LIVEKIT_API_KEY", "LIVEKIT_API_SECRET")
        values = {name: environment[name] for name in names}
    elif kind == "casdoor":
        domain = environment["CASDOOR_DOMAIN"]
        if not re.fullmatch(r"[A-Za-z0-9.-]+(?::[0-9]+)?", domain):
            raise ValueError("invalid CASDOOR_DOMAIN")
        password = environment["CASDOOR_DB_ROOT_PASSWORD"]
        if any(c in password for c in "\r\n\x00"):
            raise ValueError("database password must be a single line")
        values = {"CASDOOR_DSN": f"root:{password}@tcp(casdoor-db:3306)/",
                  "CASDOOR_ORIGIN": "https://" + domain}
    else:
        raise ValueError("unknown configuration kind")
    if any(not value for value in values.values()):
        raise ValueError("required configuration is empty")
    for name, value in values.items():
        template = template.replace("__" + name + "__", json.dumps(value))
    return template


if __name__ == "__main__":
    kind, source, destination = sys.argv[1:]
    output = render(kind, Path(source).read_text(), os.environ)
    # Dedicated named volumes are mounted only by the corresponding service.
    os.umask(0o077)
    Path(destination).write_text(output)
