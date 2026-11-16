#!/usr/bin/env python3
"""Prepare the pinned OMP sources and production dependencies."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import zipfile

from bundle_support import PLUGIN, ROOT, download, read_lock, run


def prepare_bun(lock, cache, supplied):
    if supplied:
        binary = Path(supplied).resolve()
    else:
        archive = download(lock["bun"], cache / f"bun-{lock['bun']['version']}.zip")
        binary = cache / f"bun-{lock['bun']['version']}"
        with zipfile.ZipFile(archive) as source:
            binary.write_bytes(source.read("bun-linux-x64-baseline/bun"))
        binary.chmod(0o755)
    version = subprocess.check_output([str(binary), "--version"], text=True).strip()
    if version != lock["bun"]["version"]:
        raise RuntimeError(f"This bundle requires Bun {lock['bun']['version']}.")
    return binary


def source_snapshot(spec, cache, supplied, name, paths):
    expected = spec["commit"]
    if supplied:
        source = Path(supplied).resolve()
        actual = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
        if actual != expected:
            raise RuntimeError(f"The supplied {name} checkout is not the pinned revision.")
    else:
        source = cache / f"{name}-source"
        if not (source / ".git").is_dir():
            source.mkdir(parents=True, exist_ok=True)
            run(["git", "init", "--quiet", source])
            run(["git", "remote", "add", "origin", spec["repository"]], cwd=source)
        origin = subprocess.check_output(["git", "remote", "get-url", "origin"], cwd=source, text=True).strip()
        if origin != spec["repository"]:
            raise RuntimeError(f"The {name} source cache has a different origin.")
        run(["git", "fetch", "--depth", "1", "origin", expected], cwd=source)
        actual = subprocess.check_output(["git", "rev-parse", "FETCH_HEAD"], cwd=source, text=True).strip()
        if actual != expected:
            raise RuntimeError(f"The fetched {name} revision did not match.")

    destination = PLUGIN / "vendor" / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f"{name}-source-", dir=destination.parent) as temporary:
        prepared = Path(temporary) / "source"
        prepared.mkdir()
        with tempfile.TemporaryFile() as archive:
            run(["git", "archive", expected, *paths], cwd=source, stdout=archive)
            archive.seek(0)
            with tarfile.open(fileobj=archive, mode="r:") as data:
                data.extractall(prepared, filter="data")
        (prepared / "SOURCE_COMMIT").write_text(expected + "\n")
        if destination.exists():
            shutil.rmtree(destination)
        prepared.rename(destination)
    return destination


def link_native():
    # OMP treats its source tree as a workspace and checks the native directory first.
    for variant in ("baseline", "modern"):
        source = PLUGIN / f"node_modules/@oh-my-pi/pi-natives-linux-x64/pi_natives.linux-x64-{variant}.node"
        if not source.is_file():
            raise RuntimeError("The pinned Linux native addons were not installed.")
        destination = PLUGIN / "vendor/omp/packages/natives/native" / source.name
        destination.unlink(missing_ok=True)
        destination.symlink_to(os.path.relpath(source, destination.parent))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", help="Use an existing checkout at the exact pinned commit.")
    parser.add_argument("--shims-source", help="Use an existing omp-shims checkout at its pinned commit.")
    parser.add_argument("--bun", help="Use an existing executable at the exact pinned Bun version.")
    parser.add_argument("--cache", type=Path, default=ROOT / "artifacts/cache")
    arguments = parser.parse_args()
    if os.uname().sysname != "Linux" or os.uname().machine != "x86_64":
        raise RuntimeError("This bundle target is Linux x86_64.")
    lock = read_lock()
    cache = arguments.cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    bun = prepare_bun(lock, cache, arguments.bun)
    paths = ["LICENSE", "package.json", *["packages/" + name for name in lock["upstream"]["packages"]]]
    source = source_snapshot(lock["upstream"], cache, arguments.source, "omp", paths)
    shims = source_snapshot(lock["shims"], cache, arguments.shims_source, "shims", lock["shims"]["paths"])
    run([bun, "install", "--production", "--frozen-lockfile", "--ignore-scripts"], cwd=PLUGIN)
    link_native()
    run([bun, PLUGIN / "patch-upstream.mjs", source])
    run([bun, PLUGIN / "patch-shims.mjs", shims])
    (PLUGIN / "bin").mkdir(exist_ok=True)
    if bun != (PLUGIN / "bin/bun").resolve():
        shutil.copy2(bun, PLUGIN / "bin/bun")
    run([bun, "-e", 'import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry"; '
         'if (typeof ModelRegistry !== "function") throw new Error("OMP import failed"); process.exit(0);'], cwd=PLUGIN)
    print(f"OMP {lock['upstream']['version']} prepared at {source}")
    print(f"Bun: {bun}")


if __name__ == "__main__":
    main()
