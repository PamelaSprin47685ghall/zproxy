#!/usr/bin/env python3
"""Pack the native core, Bun, OMP, and their Linux runtime dependencies."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

from bundle_support import PLUGIN, ROOT, download, read_lock, run, sha256


PLATFORM_LIBRARIES = {
    "libc.so.6", "libm.so.6", "libpthread.so.0", "libdl.so.2", "librt.so.1",
    "libutil.so.1", "libresolv.so.2", "ld-linux-x86-64.so.2",
}


def output(arguments, **options):
    return subprocess.check_output([str(value) for value in arguments], text=True, **options)


def copy_file(source, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(source, destination)


def dependencies(binary):
    program = output(["readelf", "--program-headers", "--wide", binary])
    dynamic = output(["readelf", "--dynamic", "--wide", binary])
    if not re.search(r"^\s*INTERP\s", program, re.MULTILINE) and "(NEEDED)" not in dynamic:
        return {}  # A static Go worker has no shared library or ELF loader.
    result = output(["ldd", binary], env=dict(os.environ, LC_ALL="C"))
    if "not found" in result:
        raise RuntimeError(f"A shared library is missing for {binary.name}:\n{result}")
    found = {}
    for line in result.splitlines():
        match = re.match(r"\s*(\S+) => (/\S+) ", line)
        if match:
            found[match[1]] = Path(match[2])
        else:
            loader = re.match(r"\s*(/\S+) \(", line)
            if loader:
                path = Path(loader[1])
                found[path.name] = path
    return found


def system_library(name):
    result = output(["/sbin/ldconfig", "-p"])
    for line in result.splitlines():
        match = re.match(r"\s*(\S+) \(([^)]+)\) => (/\S+)$", line)
        if match and match[1] == name and "x86-64" in match[2]:
            return Path(match[3])
    raise RuntimeError(f"Install the native dependency before packing: {name}")


def package_license(source, license_dir):
    # Use the distribution's copyright file for each redistributed system library.
    candidates = [source, source.resolve()]
    if str(source).startswith("/usr/"):
        candidates.append(Path(str(source)[4:]))
    for candidate in candidates:
        result = subprocess.run(["dpkg-query", "-S", str(candidate)], text=True, capture_output=True)
        if result.returncode == 0:
            package = result.stdout.splitlines()[0].rsplit(": ", 1)[0]
            name = package.split(":", 1)[0]
            notice = Path("/usr/share/doc") / name / "copyright"
            if not notice.is_file():
                raise RuntimeError(f"The copyright file is missing for {package}.")
            copy_file(notice, license_dir / "system" / name / "copyright")
            details = output(["dpkg-query", "-W", "-f=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}", package])
            fields = details.split("\t")
            return dict(zip(("package", "version", "sourcePackage", "sourceVersion"), fields))
    raise RuntimeError(f"Cannot identify the license for the shared library: {source}")


def bundle_libraries(appdir, binaries, license_dir):
    destination = appdir / "usr/lib/zproxy/lib"
    destination.mkdir(parents=True)
    pending = {}
    for binary in binaries:
        pending.update(dependencies(binary))
    # .NET and the compression module open these libraries at runtime.
    for name in ("libzstd.so.1", "libssl.so.3", "libcrypto.so.3"):
        pending[name] = system_library(name)
    bundled = {}
    platform = set()
    while pending:
        name, source = pending.popitem()
        if name in PLATFORM_LIBRARIES:
            platform.add(name)
            continue
        if name in bundled:
            continue
        target = destination / name
        copy_file(source, target)
        bundled[name] = {
            "sha256": sha256(target),
            **package_license(source, license_dir),
        }
        pending.update({key: value for key, value in dependencies(source).items() if key not in bundled})
    return bundled, sorted(platform)


def required_glibc(binaries):
    versions = set()
    for binary in binaries:
        result = output(["readelf", "--version-info", binary])
        versions.update(re.findall(r"\bGLIBC_(\d+(?:\.\d+)+)\b", result))
    return max(versions, key=lambda version: tuple(map(int, version.split("."))))


def copy_plugin(destination):
    # Root configuration and databases are runtime inputs, never bundle inputs.
    included = set(json.loads((PLUGIN / "package.json").read_text())["files"])
    for name in included:
        if "/" in name or name in (".", "..") or not (PLUGIN / name).exists():
            raise RuntimeError(f"Invalid or missing runtime package entry: {name}")

    def ignored(directory, names):
        ignored_names = {".git", ".cache", "__pycache__"}
        if Path(directory) == PLUGIN:
            ignored_names.update(set(names) - included)
        if Path(directory) == PLUGIN / "vendor":
            ignored_names.add("ag2api")  # Go uses the compiled worker, not its source tree.
        return ignored_names.intersection(names)

    shutil.copytree(PLUGIN, destination, symlinks=True, ignore=ignored)
    (destination / "bin").mkdir()
    (destination / "bin/bun").symlink_to(os.path.relpath(destination.parents[2] / "bin/bun", destination / "bin"))
    copy_file(PLUGIN / "bin/zproxy-ag", destination / "bin/zproxy-ag")


def checked_ag_worker(lock):
    metadata = PLUGIN / "bin/zproxy-ag.bundle.json"
    if not metadata.is_file():
        raise RuntimeError("Run scripts/prepare-ag2api.py to build the pinned codec worker first.")
    manifest = json.loads(metadata.read_text())
    if manifest["source"] != lock["ag2api"] or manifest["toolchain"] != lock["go"]:
        raise RuntimeError("The AG2API codec build has different source or toolchain pins.")
    if not manifest["static"] or manifest["workerSha256"] != sha256(PLUGIN / "bin/zproxy-ag"):
        raise RuntimeError("The AG2API codec binary does not match its build record.")
    overlay = PLUGIN / "ag2api"
    actual = {path.relative_to(overlay).as_posix(): sha256(path) for path in sorted(overlay.rglob("*.go"))}
    if actual != manifest["overlaySha256"]:
        raise RuntimeError("The AG2API codec overlay changed after its last build.")
    notices = PLUGIN / "bin/zproxy-ag-licenses"
    actual = {path.relative_to(notices).as_posix(): sha256(path) for path in sorted(notices.rglob("*")) if path.is_file()}
    if actual != manifest["licenseSha256"]:
        raise RuntimeError("The AG2API codec licenses do not match the build record.")
    return manifest


def check_links(appdir):
    for directory, names, files in os.walk(appdir):
        for name in names + files:
            path = Path(directory) / name
            if path.is_symlink():
                target = path.resolve(strict=True)
                if not target.is_relative_to(appdir):
                    raise RuntimeError(f"A bundle link points outside the AppDir: {path}")


def copy_notices(lock, cache, appdir, dotnet_root):
    destination = appdir / "usr/share/licenses/zproxy-omp"
    copy_file(PLUGIN / "vendor/omp/LICENSE", destination / "OMP-LICENSE")
    copy_file(PLUGIN / "NOTICE-shims.md", destination / "omp-shims-NOTICE.md")
    shutil.copytree(PLUGIN / "bin/zproxy-ag-licenses", destination / "ag2api")
    for key, name in (("bunLicense", "Bun-LICENSE.md"), ("appImageRuntimeLicense", "AppImage-runtime-LICENSE")):
        copy_file(download(lock[key], cache / name), destination / name)
    for name in ("LICENSE.txt", "ThirdPartyNotices.txt"):
        copy_file(dotnet_root / name, destination / "dotnet" / name)
    for name in ("LICENSE", "LICENSE.md", "LICENSE.txt"):
        if (ROOT / name).is_file():
            copy_file(ROOT / name, destination / "zproxy" / name)
    copy_file(ROOT / "packaging/NOTICE.md", destination / "NOTICE.md")
    return destination


def make_image(lock, cache, appdir, destination):
    tool = download(lock["appImageTool"], cache / "appimagetool.AppImage")
    tool.chmod(0o755)
    runtime = download(lock["appImageRuntime"], cache / "appimage-runtime")
    runtime.chmod(0o755)
    with tempfile.TemporaryDirectory(prefix="appimagetool-", dir=cache) as temporary:
        run([tool, "--appimage-extract"], cwd=temporary, stdout=subprocess.DEVNULL)
        executable = Path(temporary) / "squashfs-root/AppRun"
        run([executable, "--runtime-file", runtime, "--no-appstream", "--comp", "zstd",
             "--mksquashfs-opt", "-processors", "--mksquashfs-opt", "2", appdir, destination],
            env=dict(os.environ, ARCH="x86_64", SOURCE_DATE_EPOCH=output(["git", "show", "-s", "--format=%ct", "HEAD"], cwd=ROOT).strip()))
    destination.chmod(0o755)
    destination.with_suffix(destination.suffix + ".sha256").write_text(f"{sha256(destination)}  {destination.name}\n")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/zproxy-omp-linux-x64.AppImage")
    parser.add_argument("--cache", type=Path, default=ROOT / "artifacts/cache")
    parser.add_argument("--dotnet-root", type=Path, help="SDK directory used to publish the native binary.")
    arguments = parser.parse_args()
    if os.uname().sysname != "Linux" or os.uname().machine != "x86_64":
        parser.error("The AppImage target is Linux x86_64.")
    binary = arguments.binary.resolve()
    if not binary.is_file() or not os.access(binary, os.X_OK):
        parser.error("--binary must be the published NativeAOT executable.")
    lock = read_lock()
    for name, pin in (("omp", lock["upstream"]), ("ag2api", lock["ag2api"])):
        marker = PLUGIN / "vendor" / name / "SOURCE_COMMIT"
        if not marker.is_file() or marker.read_text().strip() != pin["commit"]:
            script = "prepare-ag2api.py" if name == "ag2api" else "prepare-omp.py"
            raise RuntimeError(f"Run scripts/{script} for the pinned {name} revision first.")
    ag_worker = checked_ag_worker(lock)
    bun = PLUGIN / "bin/bun"
    if output([bun, "--version"]).strip() != lock["bun"]["version"]:
        raise RuntimeError("The prepared Bun version does not match the lock.")
    for name in ("remote.mjs", "local.mjs", "node_modules"):
        if not (PLUGIN / name).exists():
            raise RuntimeError(f"The OMP runtime is incomplete: {name}")
    dotnet = shutil.which("dotnet")
    dotnet_root = arguments.dotnet_root or (Path(dotnet).resolve().parent if dotnet else None)
    if dotnet_root is None:
        parser.error("Set --dotnet-root to include the .NET license and third-party notices.")
    destination = arguments.output.resolve()
    destination.parent.mkdir(parents=True, exist_ok=True)
    cache = arguments.cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="zproxy-appimage-", dir=destination.parent) as temporary:
        appdir = Path(temporary) / "zproxy.AppDir"
        appdir.mkdir()
        for name in ("AppRun", "zproxy.desktop", "zproxy.svg"):
            copy_file(ROOT / "packaging" / name, appdir / name)
        (appdir / "AppRun").chmod(0o755)
        (appdir / ".DirIcon").symlink_to("zproxy.svg")
        copy_file(binary, appdir / "usr/bin/ZProxy")
        copy_file(bun, appdir / "usr/bin/bun")
        plugin = appdir / "usr/lib/zproxy/omp"
        copy_plugin(plugin)
        license_dir = copy_notices(lock, cache, appdir, dotnet_root.resolve())
        addons = list((plugin / "node_modules/@oh-my-pi/pi-natives-linux-x64").glob("*.node"))
        binaries = [appdir / "usr/bin/ZProxy", appdir / "usr/bin/bun", plugin / "bin/zproxy-ag", *addons]
        libraries, platform = bundle_libraries(appdir, binaries, license_dir)
        binaries.extend((appdir / "usr/lib/zproxy/lib").iterdir())
        manifest = {
            "schema": 1,
            "target": "linux-x64",
            "minimumGlibc": required_glibc(binaries),
            "platformLibraries": platform,
            "zproxyCommit": output(["git", "rev-parse", "HEAD"], cwd=ROOT).strip(),
            "zproxySha256": sha256(binary),
            "bunSha256": sha256(bun),
            "nativeAddonSha256": {path.name: sha256(path) for path in addons},
            "ag2apiWorker": ag_worker,
            "upstream": lock,
            "npmLockSha256": sha256(PLUGIN / "bun.lock"),
            "upstreamPatchSha256": sha256(PLUGIN / "patch-upstream.mjs"),
            "sharedLibraries": libraries,
        }
        manifest_path = appdir / "usr/share/zproxy/bundle.json"
        manifest_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        check_links(appdir)
        make_image(lock, cache, appdir, destination)
        copy_file(manifest_path, destination.with_suffix(".bundle.json"))
    print(f"AppImage: {destination}")
    print(f"Platform: Linux x86_64, glibc >= {manifest['minimumGlibc']}; FUSE is optional with --appimage-extract.")


if __name__ == "__main__":
    main()
