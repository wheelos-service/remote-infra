"""Expose target-host GStreamer development headers without hardcoded ABI paths."""

def _gstreamer_repository_impl(ctx):
    pkg_config = ctx.which("pkg-config")
    if not pkg_config:
        fail("camera_gst requires pkg-config and GStreamer development packages")
    packages = ["gstreamer-app-1.0", "gstreamer-video-1.0"]
    flags = ctx.execute([pkg_config, "--cflags-only-I"] + packages)
    libraries = ctx.execute([pkg_config, "--libs"] + packages)
    if flags.return_code or libraries.return_code:
        fail("camera_gst dependency discovery failed: " + flags.stderr + libraries.stderr)
    includes = []
    for flag in flags.stdout.strip().split(" "):
        if not flag:
            continue
        if not flag.startswith("-I"):
            fail("unsupported pkg-config include flag: " + flag)
        name = "include_" + str(len(includes))
        ctx.symlink(flag[2:], name)
        includes.append(name)
    ctx.file("BUILD.bazel", """
load("@rules_cc//cc:defs.bzl", "cc_library")
cc_library(
    name = "gstreamer",
    hdrs = glob(["include_*/**/*.h"]),
    includes = %s,
    linkopts = %s,
    visibility = ["//visibility:public"],
)
""" % (repr(includes), repr([flag for flag in libraries.stdout.strip().split(" ") if flag])))

gstreamer_repository = repository_rule(
    implementation = _gstreamer_repository_impl,
    local = True,
    configure = True,
    environ = ["PKG_CONFIG_PATH", "PKG_CONFIG_LIBDIR", "PKG_CONFIG_SYSROOT_DIR"],
)
