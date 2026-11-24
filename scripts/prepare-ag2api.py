#!/usr/bin/env python3
"""Prepare and build the optional, credential-free AG2API codec worker."""

import argparse
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile

from bundle_support import (PLUGIN, ROOT, download, read_source_commit, read_upstream_config,
                            resolve_go_latest, run, sha256, source_snapshot)


TEST_PACKAGES = ("./cmd/zproxy-ag", "./internal/api", "./internal/service", "./internal/antigravity")
GO_VERSION = re.compile(r"^go version go(\d+\.\d+(?:\.\d+)?) linux/amd64$")


def output(arguments, **options):
    return subprocess.check_output([str(value) for value in arguments], text=True, **options)


def go_version(binary, environment):
    report = output([binary, "version"], env=environment).strip()
    matched = GO_VERSION.match(report)
    if not matched:
        raise RuntimeError(f"This worker needs a Go toolchain for Linux amd64, not: {report}")
    if not (binary.parent.parent / "LICENSE").is_file():
        raise RuntimeError("The Go toolchain license is missing.")
    return matched.group(1)


def prepare_go(spec, cache, supplied):
    if supplied:
        binary = Path(supplied).resolve()
    else:
        archive = download(spec, cache / Path(spec["url"]).name)
        target = cache / f"go-{spec['version']}"
        with tempfile.TemporaryDirectory(prefix="go-source-", dir=cache) as temporary:
            with tarfile.open(archive, "r:gz") as source:
                source.extractall(temporary, filter="data")
            if target.exists():
                shutil.rmtree(target)
            (Path(temporary) / "go").rename(target)
        binary = target / "bin/go"
    environment = dict(os.environ, GOTOOLCHAIN="local", GOENV="off", GOROOT=str(binary.parent.parent))
    version = go_version(binary, environment)
    if not supplied and version != spec["version"]:
        raise RuntimeError(f"The downloaded Go toolchain reported {version}, not {spec['version']}.")
    return binary, version


def go_environment(binary, cache):
    temporary = cache / "go-tmp"
    temporary.mkdir(parents=True, exist_ok=True)
    environment = dict(os.environ)
    environment.update({
        "GOROOT": str(binary.parent.parent),
        "GOPATH": str(cache / "go-work"),
        "GOCACHE": str(cache / "go-build"),
        "GOMODCACHE": str(cache / "go-mod"),
        "GOTMPDIR": str(temporary), "TMPDIR": str(temporary),
        "GOTOOLCHAIN": "local", "GOENV": "off", "GOWORK": "off", "GOFLAGS": "",
        "GOEXPERIMENT": "", "GOTELEMETRY": "off", "CGO_ENABLED": "0",
        "GOOS": "linux", "GOARCH": "amd64", "GOAMD64": "v1",
        "GOPROXY": "https://proxy.golang.org", "GOSUMDB": "sum.golang.org",
        "GOPRIVATE": "", "GONOPROXY": "", "GONOSUMDB": "", "GOINSECURE": "",
    })
    return environment


def copy_overlay(source, required):
    overlay = PLUGIN / "ag2api"
    if not overlay.is_dir():
        if required:
            raise RuntimeError("The AG2API codec overlay is missing.")
        return {}
    hashes = {}
    for path in sorted(overlay.rglob("*")):
        if path.is_symlink():
            raise RuntimeError(f"An overlay file must not be a symlink: {path}")
        if path.is_dir():
            continue
        relative = path.relative_to(overlay)
        if path.suffix != ".go" or relative.parts[0] not in ("cmd", "internal"):
            raise RuntimeError(f"Unexpected AG2API overlay file: {relative}")
        destination = source / relative
        if destination.exists():
            raise RuntimeError(f"The AG2API overlay cannot replace an upstream file: {relative}")
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, destination)
        hashes[relative.as_posix()] = sha256(path)
    if required and not (source / "cmd/zproxy-ag/main.go").is_file():
        raise RuntimeError("The AG2API codec command is missing.")
    return hashes


def copy_licenses(source, destination):
    copied = {}
    for path in sorted(source.rglob("*")):
        name = path.name.upper()
        notice = name in ("LICENSE", "UNLICENSE", "COPYING", "COPYRIGHT", "NOTICE", "PATENTS") or name.startswith(
            ("LICENSE.", "LICENSE-", "UNLICENSE.", "COPYING.", "COPYING-", "COPYRIGHT.", "NOTICE.", "NOTICE-", "PATENTS."))
        if not path.is_file() or not notice or path.suffix.lower() in (".go", ".c", ".h", ".cc", ".py", ".js", ".ts"):
            continue
        if not path.resolve().is_relative_to(source.resolve()):
            raise RuntimeError(f"A license file points outside its source: {path}")
        relative = path.relative_to(source)
        target = destination / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
        copied[relative.as_posix()] = sha256(path)
    if not copied:
        raise RuntimeError(f"No license was found for the Go dependency: {source.name}")
    return copied


def dependency_notices(go, source, environment, destination):
    modules = output([go, "list", "-mod=readonly", "-deps", "-f",
                      "{{if .Module}}{{.Module.Path}}\t{{.Module.Version}}\t{{.Module.Dir}}{{end}}",
                      "./cmd/zproxy-ag"], cwd=source, env=environment)
    records = []
    for line in sorted(set(modules.splitlines())):
        if not line:
            continue
        name, version, directory = line.split("\t")
        if not version:
            continue  # The main module is the fetched source and carries its own license.
        licenses = copy_licenses(Path(directory), destination / "modules" / name)
        records.append({"module": name, "version": version, "licenses": licenses})
    copy_licenses(go.parent.parent, destination / "go")
    shutil.copy2(source / "LICENSE", destination / "AG2API-LICENSE")
    return records


def check_static(binary):
    program = output(["readelf", "--program-headers", "--wide", binary])
    dynamic = output(["readelf", "--dynamic", "--wide", binary])
    if " INTERP " in program or "(NEEDED)" in dynamic:
        raise RuntimeError("The AG2API codec worker must be a static Linux executable.")


def build(go, source, config, commit, overlay, cache):
    environment = go_environment(go, cache)
    run([go, "test", "-mod=readonly", "-p=2", "-count=1", "-timeout=120s", *TEST_PACKAGES],
        cwd=source, env=environment)
    destination = PLUGIN / "bin"
    destination.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="ag2api-build-", dir=destination) as temporary:
        working = Path(temporary)
        binary = working / "zproxy-ag"
        run([go, "build", "-mod=readonly", "-p=2", "-trimpath", "-buildvcs=false",
             "-ldflags=-s -w -buildid= -X main.upstreamVersion=" + commit,
             "-o", binary, "./cmd/zproxy-ag"], cwd=source, env=environment)
        check_static(binary)
        run([go, "mod", "verify"], cwd=source, env=environment)
        version = output([binary, "--version"], timeout=10).strip()
        if commit not in version:
            raise RuntimeError("The worker version does not include the fetched AG2API commit.")
        notices = working / "zproxy-ag-licenses"
        notices.mkdir()
        modules = dependency_notices(go, source, environment, notices)
        manifest = {
            "schema": 1, "target": "linux-amd64", "static": True,
            "source": {"repository": config["repository"], "commit": commit},
            "toolchain": {"version": go_version(go, environment)},
            "workerSha256": sha256(binary), "overlaySha256": overlay,
            "licenseSha256": {path.relative_to(notices).as_posix(): sha256(path)
                              for path in sorted(notices.rglob("*")) if path.is_file()},
            "testPackages": list(TEST_PACKAGES), "modules": modules,
        }
        (working / "zproxy-ag.bundle.json").write_text(json.dumps(manifest, indent=2) + "\n")
        previous = destination / notices.name
        if previous.exists():
            shutil.rmtree(previous)
        notices.rename(previous)
        binary.replace(destination / binary.name)
        (working / "zproxy-ag.bundle.json").replace(destination / "zproxy-ag.bundle.json")
    print(f"AG2API codec worker: {destination / 'zproxy-ag'}")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", help="Use a local AG2API checkout instead of the newest upstream one.")
    parser.add_argument("--go", help="Use an installed Go toolchain instead of the newest stable one.")
    parser.add_argument("--cache", type=Path, default=ROOT / "artifacts/cache")
    parser.add_argument("--prepare-only", action="store_true", help="Prepare sources and Go without building the overlay.")
    arguments = parser.parse_args()
    if os.uname().sysname != "Linux" or os.uname().machine != "x86_64":
        parser.error("The codec bundle target is Linux x86_64.")
    config = read_upstream_config()
    cache = arguments.cache.resolve()
    cache.mkdir(parents=True, exist_ok=True)
    spec = None if arguments.go else resolve_go_latest(config["go"]["downloadIndex"])
    go, toolchain = prepare_go(spec, cache, arguments.go)
    source = source_snapshot(config["ag2api"], cache, arguments.source, "ag2api")
    commit = read_source_commit(source)
    if not (source / "LICENSE").is_file():
        raise RuntimeError("The AG2API license is missing.")
    overlay = copy_overlay(source, required=not arguments.prepare_only)
    print(f"AG2API source {config['ag2api']['repository']} at {commit}: {source}", flush=True)
    print(f"Go {toolchain}: {go}", flush=True)
    if not arguments.prepare_only:
        build(go, source, config["ag2api"], commit, overlay, cache)


if __name__ == "__main__":
    main()
