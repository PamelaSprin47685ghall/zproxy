"""Small shared operations for the Linux OMP bundle."""

import hashlib
import json
from pathlib import Path
import shutil
import subprocess
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
