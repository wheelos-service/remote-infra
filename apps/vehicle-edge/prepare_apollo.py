#!/usr/bin/env python3
"""Prepare an isolated Apollo source view without writing to Apollo itself."""

import argparse
from pathlib import Path
import re


EDGE = Path(__file__).resolve().parent
STATE = EDGE / ".apollo-local"


def write_changed(path, content):
    if path.is_symlink():
        path.unlink()
    if not path.exists() or path.read_text() != content:
        path.write_text(content)


def link(path, target):
    if path.is_symlink() and path.readlink() == target:
        return
    if path.exists() or path.is_symlink():
        raise RuntimeError(f"refusing to replace existing path: {path}")
    path.symlink_to(target, target_is_directory=target.is_dir())


def materialize(workspace, apollo, relative):
    """Replace directory links with directories of links before overriding a file."""
    current = workspace
    source = apollo
    for part in relative.parts:
        current = current / part
        source = source / part
        if current.is_symlink():
            current.unlink()
            current.mkdir()
            for child in source.iterdir():
                link(current / child.name, child)
    return current


def prepare(apollo):
    apollo = apollo.resolve()
    if not (apollo / "cyber/python/internal/py_cyber.cc").is_file():
        raise RuntimeError(f"Apollo source tree not found: {apollo}")
    workspace = STATE / "workspace"
    workspace.mkdir(parents=True, exist_ok=True)
    excluded = {"MODULE.bazel", "MODULE.bazel.lock", ".bazelrc", ".custom.bazelrc",
                ".git", ".cache", "remote-infra", "data"}
    for child in apollo.iterdir():
        if child.name in excluded or child.name.startswith("bazel-"):
            continue
        # Existing materialized directories contain the intentional local overrides.
        if (workspace / child.name).is_dir() and not (workspace / child.name).is_symlink():
            continue
        link(workspace / child.name, child)

    module = (apollo / "MODULE.bazel").read_text()
    module, count = re.subn(r'python_version\s*=\s*"3\.8"',
                            'python_version = "3.10"', module)
    if count != 2:
        raise RuntimeError("expected Apollo's Python 3.8 defaults and toolchain; inspect MODULE.bazel")
    module += '''
# vehicle-edge overlay: Python dependencies share Apollo's Cyber build.
pip = use_extension("@rules_python//python/extensions:pip.bzl", "pip")
pip.parse(
    hub_name = "vehicle_pip",
    python_version = "3.10",
    requirements_lock = "//vehicle_edge_local:requirements-cyber.txt",
)
use_repo(pip, "vehicle_pip")
'''
    write_changed(workspace / "MODULE.bazel", module)
    # Do not inherit a developer override that might redirect outputs outside STATE.
    rc = (apollo / ".bazelrc").read_text()
    rc = "\n".join(line for line in rc.splitlines()
                   if not line.startswith("try-import ")) + "\n"
    write_changed(workspace / ".bazelrc", rc)
    package = workspace / "vehicle_edge_local"
    package.mkdir(exist_ok=True)
    for name in ("src", "tests", "apollo_vehicle_main.py", "probe_apollo_feedback.py",
                 "requirements-cyber.txt"):
        link(package / name, EDGE / name)
    write_changed(package / "BUILD.bazel", (EDGE / "BUILD.apollo").read_text())

    # Clear() joins scheduler threads whose Python callbacks may need the GIL.
    # Patch only this build's copy; the Apollo source and its bindings stay untouched.
    internal = materialize(workspace, apollo, Path("cyber/python/internal"))
    wrapper = (apollo / "cyber/python/internal/py_cyber.cc").read_text()
    old = "  apollo::cyber::py_shutdown();"
    if wrapper.count(old) != 1:
        raise RuntimeError("Apollo shutdown binding changed; inspect py_cyber.cc")
    wrapper = wrapper.replace(old, "  Py_BEGIN_ALLOW_THREADS\n" + old + "\n  Py_END_ALLOW_THREADS")
    write_changed(internal / "py_cyber.cc", wrapper)
    return workspace


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apollo-root", type=Path, default=EDGE.parents[2])
    args = parser.parse_args()
    print(prepare(args.apollo_root))
