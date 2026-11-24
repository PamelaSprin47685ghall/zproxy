#!/usr/bin/env python3
"""Check the static AG2API codec using only a private socket and owned fixtures."""

import argparse
import http.client
import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import time

from bundle_support import PLUGIN


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def encoded(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False).encode()


def frame(value):
    return b"data: " + encoded(value) + b"\n\n"


class WorkerConnection(http.client.HTTPConnection):
    def __init__(self, path):
        super().__init__("localhost", timeout=10)
        self.path = str(path)

    def connect(self):
        self.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        self.sock.settimeout(self.timeout)
        self.sock.connect(self.path)


def request(path, method, route, body=None):
    connection = WorkerConnection(path)
    try:
        connection.request(method, route, body=encoded(body) if body is not None else None,
                           headers={"Content-Type": "application/json"})
        response = connection.getresponse()
        payload = response.read(1 << 20)
        require(response.status == 200, f"AG2API {route} failed: {response.status}: {payload[:1024]!r}")
        return json.loads(payload)
    finally:
        connection.close()


def decode(path):
    original = {
        "model": "fixture-alias", "messages": [{"role": "user", "content": "fixture question"}],
        "stream": True, "stream_options": {"include_usage": True},
    }
    prepared = request(path, "POST", "/prepare", {
        "version": 1, "request": original, "project": "fixture-project", "session": "fixture-session",
        "model": {"id": "gemini-fixture", "modelProvider": "MODEL_PROVIDER_GOOGLE",
                  "maxOutputTokens": 1024, "maxTokens": 4096},
    })
    require(isinstance(prepared.get("userAgent"), str) and prepared["userAgent"] and
            not any(c in prepared["userAgent"] for c in "\r\n"), "The codec omitted its official User-Agent.")
    require(prepared["body"]["project"] == "fixture-project", "The wire request lost its private project.")
    require(prepared["body"]["model"] == "gemini-fixture", "The wire request lost its resolved model.")
    require("fixture question" in json.dumps(prepared["body"]["request"]), "The wire request lost the prompt.")
    require(request(path, "POST", "/augment", original) == original, "An empty signature cache changed the request.")

    original_bytes = encoded(original)
    recipe = {"api": "antigravity2api", "provider": "google-antigravity", "id": "gemini-fixture",
              "reasoning": False, "input": ["text"], "contextWindow": 4096, "maxTokens": 1024,
              "compat": {"agProvider": "google"}}
    envelope = encoded({
        "version": 1, "path": "/v1/chat/completions", "requestBytes": len(original_bytes), "status": 200,
        "headers": [["Content-Type", "text/event-stream"]],
        "metadata": {"decoder": "omp-response", "version": 1, "modelAlias": "fixture-alias",
                     "requestId": "fixture-request", "attempt": 1, "isStreaming": True,
                     "recipe": encoded(recipe).decode()},
    })
    first = frame({"response": {"candidates": [{"content": {"role": "model", "parts": [{"text": "Hello"}]}}]}})
    terminal = frame({"response": {
        "candidates": [{"content": {"role": "model", "parts": []}, "finishReason": "STOP"}],
        "usageMetadata": {"promptTokenCount": 2, "cachedContentTokenCount": 1, "candidatesTokenCount": 1, "totalTokenCount": 3},
    }})
    connection = WorkerConnection(path)
    try:
        connection.putrequest("POST", "/decode")
        connection.putheader("Content-Type", "application/octet-stream")
        connection.putheader("Transfer-Encoding", "chunked")
        connection.endheaders()

        def chunk(data):
            connection.send(f"{len(data):X}\r\n".encode() + data + b"\r\n")

        chunk(struct.pack(">I", len(envelope)) + envelope + original_bytes + first)
        response = connection.getresponse()
        require(response.status == 200, "The AG2API decoder rejected its fixture.")
        events = []
        seen = 0
        while True:
            line = response.readline(65537)
            seen += len(line)
            require(line and len(line) <= 65536 and seen <= 1 << 20, "The AG2API stream ended before its first text.")
            if not line.startswith(b"data: "):
                continue
            event = json.loads(line[6:])
            require("error" not in event, f"The AG2API decoder returned an error: {event}")
            events.append(event)
            if any(choice.get("delta", {}).get("content") == "Hello" for choice in event.get("choices", [])):
                break
        # The final SSE frame and request EOF have not been sent yet.
        require(any(event.get("model") == "fixture-alias" for event in events), "The public model alias was lost.")
        chunk(terminal)
        connection.send(b"0\r\n\r\n")
        rest = response.read(1 << 20)
        require(b"data: [DONE]" in rest, "The AG2API output omitted its terminal marker.")
        for line in rest.splitlines():
            if line.startswith(b"data: ") and line != b"data: [DONE]":
                events.append(json.loads(line[6:]))
        require(all("error" not in event for event in events), "The AG2API stream ended with an error.")
        require(any((event.get("usage") or {}).get("total_tokens") == 3 for event in events), "The AG2API output lost usage.")
        require(any((event.get("usage") or {}).get("prompt_tokens_details", {}).get("cached_tokens") == 1
                    for event in events), "The AG2API output lost cached input tokens.")
        require(any(choice.get("finish_reason") == "stop" for event in events for choice in event.get("choices", [])),
                "The AG2API output lost its finish reason.")
    finally:
        connection.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    arguments = parser.parse_args()
    binary = arguments.binary.resolve()
    manifest_path = PLUGIN / "bin/zproxy-ag.bundle.json"
    recorded = ""
    if manifest_path.exists():
        source = json.loads(manifest_path.read_text()).get("source") or {}
        recorded = source.get("commit", "")
    if not recorded:
        stamp = PLUGIN / "vendor/ag2api/SOURCE_COMMIT"
        recorded = stamp.read_text().strip() if stamp.exists() else ""
    version = subprocess.check_output([binary, "--version"], text=True, timeout=10)
    require(recorded and recorded in version, "The codec worker does not match its recorded AG2API revision.")
    with tempfile.TemporaryDirectory(prefix="za-") as temporary:
        working = Path(temporary)
        path = working / "codec.sock"
        log = working / "worker.log"
        environment = {key: value for key, value in os.environ.items()
                       if key in ("PATH", "LD_LIBRARY_PATH", "LANG", "LC_ALL", "TZ")}
        environment.update({"HOME": str(working), "TMPDIR": str(working)})
        with log.open("wb") as output:
            process = subprocess.Popen([binary, "--socket", path], cwd=working, env=environment,
                                       stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)
            try:
                deadline = time.monotonic() + 10
                while not path.exists():
                    require(process.poll() is None, "The AG2API codec exited during startup.")
                    require(time.monotonic() < deadline, "The AG2API codec did not create its socket.")
                    time.sleep(0.02)
                require(request(path, "GET", "/health") == {"ready": True}, "The codec was not ready.")
                decode(path)
                request(path, "POST", "/shutdown", {})
                require(process.wait(timeout=10) == 0, "The codec did not stop cleanly.")
                require(not path.exists(), "The codec left its private socket after shutdown.")
                require({item.name for item in working.iterdir()} == {"worker.log"}, "The codec created unexpected persistent state.")
            except Exception:
                print(log.read_text(errors="replace")[-8192:])
                raise
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=3)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=3)
    print("AG2API codec smoke passed: request preparation, visible text before raw EOF, usage, and clean shutdown.")


if __name__ == "__main__":
    main()
