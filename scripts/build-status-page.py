#!/usr/bin/env python3
"""Build the embedded status page.

The output directory `src/ZProxy/StatusAssets` is committed and packed into the
NativeAOT binary as an EmbeddedResource, so publishing needs neither Bun nor
Node. Run with `--check` in CI to fail when the committed assets are stale.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRONTEND = ROOT / "frontend"
OUT = ROOT / "src" / "ZProxy" / "StatusAssets"


def run(command: list[str], cwd: Path) -> None:
    print("+", " ".join(command), f"(in {cwd})", flush=True)
    if subprocess.run(command, cwd=cwd).returncode != 0:
        raise SystemExit(f"command failed: {' '.join(command)}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="fail when the committed assets differ from a fresh build")
    args = parser.parse_args()

    if shutil.which("bun"):
        install = ["bun", "install", "--frozen-lockfile"]
        build = ["bunx", "vite", "build"]
    elif shutil.which("npm"):
        # No package-lock.json is committed, so `npm ci` cannot run.
        install = ["npm", "install", "--no-audit", "--no-fund"]
        build = ["npx", "--yes", "vite", "build"]
    else:
        raise SystemExit("bun or npm is required to rebuild the status page")

    if not (FRONTEND / "node_modules").exists():
        run(install, FRONTEND)
    run(build, FRONTEND)

    if not (OUT / "manifest.json").exists():
        raise SystemExit(f"missing {OUT / 'manifest.json'} after the build")

    if args.check:
        # `git diff` ignores untracked files, so a fresh build that adds new
        # hashed names would look current. Status covers both cases.
        stale = subprocess.run(["git", "status", "--porcelain", "--", "src/ZProxy/StatusAssets"],
                               cwd=ROOT, capture_output=True, text=True)
        if stale.returncode != 0:
            raise SystemExit("cannot inspect the committed status page assets")
        if stale.stdout.strip():
            raise SystemExit("status page assets are stale; run this script and commit the result\n" + stale.stdout)
        print("status page assets are current")


if __name__ == "__main__":
    main()
