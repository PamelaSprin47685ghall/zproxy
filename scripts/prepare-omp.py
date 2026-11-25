#!/usr/bin/env python3
"""Prepare the newest OMP sources and production dependencies."""

import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile

from bundle_support import (PLUGIN, ROOT, download_file, read_source_commit, read_upstream_config, resolve, run,
                            source_snapshot)

SUPPORTED_TARGETS = {
    ("Linux", "x86_64"): "linux-x64",
    ("Darwin", "arm64"): "darwin-arm64",
}


def target_for(system, machine):
    target = SUPPORTED_TARGETS.get((system, machine))
    if target is None:
        supported = ", ".join(sorted(SUPPORTED_TARGETS.values()))
        raise RuntimeError(f"OMP bundles are supported on {supported}; found {system} {machine}.")
    return target


def bun_asset_for(config, target):
    return config["bun"]["assets"][target]


def native_addon_names(target):
    if target == "linux-x64":
        return ("pi_natives.linux-x64-baseline.node", "pi_natives.linux-x64-modern.node")
    if target == "darwin-arm64":
        return ("pi_natives.darwin-arm64.node",)
    raise RuntimeError(f"No native addon layout is configured for {target}.")


def version_tuple(text):
    return tuple(int(part) for part in text.split(".") if part.isdigit())


def prepare_bun(config, cache, supplied, target):
    base_spec = config["bun"]
    asset = bun_asset_for(config, target)
    spec = {**base_spec, "asset": asset}
    if supplied:
        binary = Path(supplied).resolve()
    else:
        resolved = resolve(spec)
        asset = Path(spec["asset"])
        archive = download_file(resolved["url"], cache / "bun" / asset.name, resolved["sha256"])
        binary = cache / "bun" / Path(resolved["tag"]).name / "bun"
        binary.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(archive) as source:
            binary.write_bytes(source.read(f"{asset.stem}/bun"))
        binary.chmod(0o755)
    version = subprocess.check_output([str(binary), "--version"], text=True).strip()
    if version_tuple(version) < version_tuple(spec["minimumVersion"]):
        raise RuntimeError(f"Bun {version} is older than the supported {spec['minimumVersion']}.")
    return binary, version


def native_version(root):
    return json.loads((root / "vendor/omp/packages/natives/package.json").read_text())


def link_native(config, target):
    # The platform addon is published per OMP release, so the newest published
    # copy must still match the vendored source before its binary is linked in.
    expected = native_version(PLUGIN)["version"]
    package = config["native"]["packages"][target]
    addon = PLUGIN / "node_modules" / package / "package.json"
    if not addon.is_file():
        raise RuntimeError(f"The {target} native package {package} was not installed.")
    installed = json.loads(addon.read_text())["version"]
    if installed != expected:
        print(f"Warning: the published native addon is {installed} but the OMP source is "
              f"{expected}; linking the published binaries anyway.")
    # OMP treats its source tree as a workspace and checks the native directory first.
    for name in native_addon_names(target):
        source = PLUGIN / "node_modules" / package / name
        if not source.is_file():
            raise RuntimeError(f"The {target} native addon was not installed.")
        destination = PLUGIN / "vendor/omp/packages/natives/native" / source.name
        destination.unlink(missing_ok=True)
        destination.symlink_to(os.path.relpath(source, destination.parent))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", help="Use an existing OMP checkout; its HEAD is the newest source.")
    parser.add_argument("--bun", help="Use an existing Bun executable instead of the newest release.")
    parser.add_argument("--cache", type=Path, default=ROOT / "artifacts/cache")
    arguments = parser.parse_args()
    target = target_for(os.uname().sysname, os.uname().machine)
    config = read_upstream_config()
    cache = arguments.cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    bun, bun_version = prepare_bun(config, cache, arguments.bun, target)
    source = source_snapshot(config["upstream"], cache, arguments.source, "omp",
                             tuple(["LICENSE", "package.json", *["packages/" + name for name in config["upstream"]["packages"]]]))
    # The lockfile is a build artifact: it follows the newest catalog and is never committed.
    (PLUGIN / "bun.lock").unlink(missing_ok=True)
    run([bun, "install", "--production", "--ignore-scripts"], cwd=PLUGIN)
    link_native(config, target)
    run([bun, PLUGIN / "patch-upstream.mjs", source])
    (PLUGIN / "bin").mkdir(exist_ok=True)
    if bun != (PLUGIN / "bin/bun").resolve():
        shutil.copy2(bun, PLUGIN / "bin/bun")
    run([bun, "-e", 'import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry"; '
         'if (typeof ModelRegistry !== "function") throw new Error("OMP import failed"); process.exit(0);'], cwd=PLUGIN)
    commit = read_source_commit(source)
    print(f"OMP {commit} prepared for {target} at {source}")
    print(f"Bun {bun_version}: {bun}")


if __name__ == "__main__":
    main()
