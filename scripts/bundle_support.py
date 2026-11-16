"""Small shared operations for the Linux OMP bundle."""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import tarfile
import tempfile
import urllib.request


ROOT = Path(__file__).resolve().parents[1]
PLUGIN = ROOT / "plugins" / "omp"


def read_lock():
    return json.loads((PLUGIN / "upstream.lock.json").read_text())


def run(arguments, **options):
    subprocess.run([str(value) for value in arguments], check=True, **options)


def sha256(path):
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download(spec, destination):
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.is_file() and sha256(destination) == spec["sha256"]:
        return destination
    temporary = destination.with_name(destination.name + ".part")
    try:
        with urllib.request.urlopen(spec["url"], timeout=60) as response, temporary.open("wb") as output:
            shutil.copyfileobj(response, output)
        if sha256(temporary) != spec["sha256"]:
            raise RuntimeError(f"The download hash does not match: {destination.name}")
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def source_snapshot(spec, cache, supplied, name, paths=()):
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
