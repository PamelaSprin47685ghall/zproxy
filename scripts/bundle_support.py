"""Small shared operations for the Linux OMP bundle.

Every dependency follows the newest upstream revision. A lock file records no
version, only where the newest revision comes from.
"""

import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tarfile
import tempfile
import urllib.error
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "omp"


def read_upstream_config():
    config = json.loads((PLUGIN / "upstream.json").read_text())
    # License files follow the newest release of the artifact they ship with.
    config["bunLicense"] = {"repository": "oven-sh/bun", "raw": "LICENSE.md"}
    config["appImageRuntimeLicense"] = {"repository": "AppImage/type2-runtime", "raw": "LICENSE"}
    return config


# Older call sites import this name; it reads the same configuration.
read_lock = read_upstream_config


def run(arguments, **options):
    subprocess.run([str(value) for value in arguments], check=True, **options)


def sha256(path):
    with Path(path).open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def request(url):
    headers = {"User-Agent": "zproxy-build"}
    token = os.environ.get("GITHUB_TOKEN")
    if token and url.startswith("https://api.github.com/"):
        headers["Authorization"] = f"Bearer {token}"
    return urllib.request.Request(url, headers=headers)


def fetch_json(url):
    with urllib.request.urlopen(request(url), timeout=60) as response:
        return json.loads(response.read().decode())


def latest_tag(repository):
    """Return the newest release tag, without downloading a release asset."""
    try:
        return fetch_json(f"https://api.github.com/repos/{repository}/releases/latest")["tag_name"]
    except (urllib.error.HTTPError, KeyError):
        pass
    # The release page redirect names the tag when the API is rate limited.
    opener = urllib.request.build_opener(urllib.request.HTTPRedirectHandler)
    try:
        with opener.open(request(f"https://github.com/{repository}/releases/latest"), timeout=60) as response:
            match = re.search(r"/releases/tag/([^/?#]+)", response.url)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Cannot resolve the newest {repository} release: {error}") from error
    if not match:
        raise RuntimeError(f"The {repository} release redirect has no tag.")
    return match.group(1)


def latest_sha256(repository, tag, asset):
    """Read a published checksum for the asset, or None when the release publishes none."""
    for name in (f"{asset}.sha256", "SHASUMS256.txt", "sha256sums.txt"):
        url = f"https://github.com/{repository}/releases/download/{tag}/{name}"
        try:
            with urllib.request.urlopen(request(url), timeout=30) as response:
                text = response.read().decode(errors="replace")
        except urllib.error.HTTPError:
            continue
        for line in text.splitlines():
            fields = line.split()
            if len(fields) >= 2 and Path(fields[-1].lstrip("*")).name == asset:
                if re.fullmatch(r"[0-9a-f]{64}", fields[0]):
                    return fields[0]
    return None


def resolve_go_latest(index_url):
    """Return the newest stable Go archive for Linux x86_64."""
    for release in fetch_json(index_url):
        if not release.get("stable"):
            continue
        for item in release["files"]:
            if item["os"] == "linux" and item["arch"] == "amd64" and item["kind"] == "archive":
                return {
                    "version": release["version"].lstrip("go"),
                    "url": f"https://go.dev/dl/{item['filename']}",
                    "sha256": item["sha256"],
                }
    raise RuntimeError("The Go download index has no stable Linux x86_64 archive.")


def resolve(spec):
    """Resolve a configuration entry to a concrete url and its published checksum."""
    if spec.get("url"):
        return spec
    repository = spec["repository"].removeprefix("https://github.com/").removesuffix(".git")
    if spec.get("downloadIndex"):
        return resolve_go_latest(spec["downloadIndex"])
    tag = latest_tag(repository)
    if spec.get("raw"):
        return {
            "tag": tag,
            "url": f"https://raw.githubusercontent.com/{repository}/{tag}/{spec['raw']}",
            "sha256": None,
        }
    asset = spec["asset"]
    return {
        "tag": tag,
        "asset": asset,
        "url": f"https://github.com/{repository}/releases/download/{tag}/{asset}",
        "sha256": spec.get("sha256") or latest_sha256(repository, tag, asset),
    }


def download_file(url, destination, expected_sha256=None):
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(destination.name + ".part")
    try:
        with urllib.request.urlopen(request(url), timeout=300) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output)
        if expected_sha256 and sha256(temporary) != expected_sha256:
            raise RuntimeError(f"The download hash does not match: {destination.name}")
        if destination.is_file() and sha256(destination) == sha256(temporary):
            return destination
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def download(spec, destination):
    resolved = resolve(spec)
    return download_file(resolved["url"], destination, resolved["sha256"])


def read_source_commit(source):
    return (Path(source) / "SOURCE_COMMIT").read_text().strip()


def source_snapshot(spec, cache, supplied, name, paths=()):
    """Snapshot the newest revision of a source tree and record what it was."""
    destination = PLUGIN / "vendor" / name
    if supplied:
        source = Path(supplied).resolve()
        if (source / ".git").exists():
            top = subprocess.check_output(["git", "rev-parse", "--show-toplevel"], cwd=source, text=True).strip()
            if Path(top).resolve() != source:
                raise RuntimeError(f"{source} has no repository of its own; it belongs to {top}.")
            commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
        elif (source / "SOURCE_COMMIT").is_file():
            # An already prepared snapshot is immutable; copy it without a repository.
            commit = read_source_commit(source)
            if source == destination.resolve():
                return destination
            if destination.exists():
                shutil.rmtree(destination)
            shutil.copytree(source, destination, symlinks=True)
            return destination
        else:
            raise RuntimeError(f"{source} is neither a checkout nor a prepared snapshot.")
    else:
        source = cache / f"{name}-source"
        if not (source / ".git").is_dir():
            source.mkdir(parents=True, exist_ok=True)
            run(["git", "init", "--quiet", source])
        origin = subprocess.check_output(["git", "remote", "get-url", "origin"], cwd=source, text=True).strip()
        if origin != spec["repository"]:
            run(["git", "remote", "set-url", "origin", spec["repository"]], cwd=source)
        run(["git", "fetch", "--depth", "1", "origin", "HEAD"], cwd=source)
        commit = subprocess.check_output(["git", "rev-parse", "FETCH_HEAD"], cwd=source, text=True).strip()

    destination = PLUGIN / "vendor" / name
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=f"{name}-source-", dir=destination.parent) as temporary:
        prepared = Path(temporary) / "source"
        prepared.mkdir()
        with tempfile.TemporaryFile() as archive:
            run(["git", "archive", commit, *paths], cwd=source, stdout=archive)
            archive.seek(0)
            with tarfile.open(fileobj=archive, mode="r:") as data:
                data.extractall(prepared, filter="data")
        (prepared / "SOURCE_COMMIT").write_text(commit + "\n")
        if destination.exists():
            shutil.rmtree(destination)
        prepared.rename(destination)
    return destination
