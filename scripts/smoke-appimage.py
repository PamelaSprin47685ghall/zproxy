#!/usr/bin/env python3
"""Extract the real AppImage and run both proxy paths without host Bun or .NET."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

from bundle_support import ROOT, read_lock, run, sha256


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, type=Path)
    arguments = parser.parse_args()
    image = arguments.image.resolve()
    lock = read_lock()
    with tempfile.TemporaryDirectory(prefix="zproxy-image-") as temporary:
        working = Path(temporary)
        run([image, "--appimage-extract"], cwd=working, stdout=subprocess.DEVNULL, timeout=120)
        appdir = working / "squashfs-root"
        launcher = appdir / "AppRun"
        bun = appdir / "usr/bin/bun"
        plugin = appdir / "usr/lib/zproxy/omp"
        commands = working / "commands"
        commands.mkdir()
        # AppRun and the isolated AG fixture need these host tools. No host
        # Bun, dotnet, or Go command is available to the extracted bundle.
        for name in ("dirname", "unshare", "true", "ip", "mount", "openssl"):
            executable = shutil.which(name) or shutil.which(name, path="/usr/sbin:/sbin")
            if not executable:
                raise RuntimeError(f"The extracted AppImage smoke requires {name}.")
            (commands / name).symlink_to(Path(executable).resolve())
        environment = {key: value for key, value in os.environ.items()
                       if not key.startswith(("DOTNET_", "ZPROXY_", "BUN_", "PI_"))
                       and key not in ("APPDIR", "LD_LIBRARY_PATH", "NODE_PATH")}
        environment.update({
            "PATH": str(commands),
            "PI_CODING_AGENT_DIR": str(working / "empty-omp-config"),
        })
        bundle_environment = {**environment, "LD_LIBRARY_PATH": str(appdir / "usr/lib/zproxy/lib")}
        run([launcher, "--help"], env=environment, stdout=subprocess.DEVNULL, timeout=15)
        version = subprocess.check_output([str(bun), "--version"], env=bundle_environment, text=True, timeout=15).strip()
        if version != lock["bun"]["version"]:
            raise RuntimeError("The extracted Bun version does not match the lock.")
        manifest = json.loads((appdir / "usr/share/zproxy/bundle.json").read_text())
        if manifest["upstream"]["upstream"]["commit"] != lock["upstream"]["commit"]:
            raise RuntimeError("The image includes a different OMP source revision.")
        if manifest["upstream"]["shims"]["commit"] != lock["shims"]["commit"]:
            raise RuntimeError("The image includes a different omp-shims source revision.")
        worker = plugin / "bin/zproxy-ag"
        if (manifest["ag2apiWorker"]["source"] != lock["ag2api"]
                or manifest["ag2apiWorker"]["workerSha256"] != sha256(worker)):
            raise RuntimeError("The image includes a different AG2API codec worker.")
        if (plugin / "vendor/ag2api").exists():
            raise RuntimeError("The AG2API source build tree must not enter the image.")
        run([sys.executable, ROOT / "scripts/smoke-ag2api.py", "--binary", worker], env=environment, timeout=60)
        run([bun, "-e", 'import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry"; '
             'import { LazyRouter } from "./vendor/shims/lib/router/router.mjs"; '
             'await import("@oh-my-pi/pi-ai/providers/openai-chat-server"); '
             'if (typeof ModelRegistry !== "function" || typeof LazyRouter !== "function") '
             'throw new Error("OMP import failed"); process.exit(0);'],
            cwd=plugin, env=bundle_environment, timeout=30)
        run([bun, plugin / "vendor/omp/packages/coding-agent/src/cli.ts", "--help"],
            cwd=plugin, env=bundle_environment, stdout=subprocess.DEVNULL, timeout=30)
        run([sys.executable, ROOT / "scripts/smoke-native.py", "--binary", launcher], env=environment, timeout=90)
        run([sys.executable, ROOT / "scripts/smoke-omp.py", "--binary", launcher, "--omp-dir", plugin],
            env=environment, timeout=150)
        run([sys.executable, ROOT / "scripts/smoke-omp.py", "--binary", launcher, "--omp-dir", plugin, "--antigravity2api"],
            env=environment, timeout=150)
    print("AppImage smoke passed: extracted NativeAOT core, bundled Bun, OMP and Go codec, direct relay, and split response conversion.")


if __name__ == "__main__":
    main()
