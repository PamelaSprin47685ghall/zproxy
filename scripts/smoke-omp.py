#!/usr/bin/env python3
"""Check the native OMP bridge and bundled workers with owned loopback traffic."""

import argparse
import concurrent.futures
import contextlib
import http.client
import http.cookies
import http.server
import json
import os
from pathlib import Path
import queue
import secrets
import signal
import socket
import subprocess
import tempfile
import threading
import time


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def free_ports():
    with contextlib.ExitStack() as stack:
        sockets = [stack.enter_context(socket.socket()) for _ in range(3)]
        for connection in sockets:
            connection.bind(("127.0.0.1", 0))
        return [connection.getsockname()[1] for connection in sockets]


def descendants(pid):
    result = set()
    pending = [pid]
    while pending:
        current = pending.pop()
        path = Path(f"/proc/{current}/task/{current}/children")
        if path.exists():
            children = {int(value) for value in path.read_text().split()}
            pending.extend(children - result)
            result.update(children)
    return result


def run(binary, omp_dir, timeout, antigravity=False):
    deadline = time.monotonic() + timeout
    password, provider_key, caller_key = (secrets.token_urlsafe(32) for _ in range(3))
    user_uuid = ""
    nickname = "OMP smoke 用户"
    release = threading.Event()
    finish_stream = threading.Event()
    origin_finished = threading.Event()
    failures = queue.Queue()
    raw_bytes = [0]
    raw_lock = threading.Lock()
    legacy_count = 6 if antigravity else 1
    legacy_started = [0]
    legacy_ready = threading.Event()
    signature = "owned-fixture-thought-signature"
    original = {"model": "fixture-alias", "messages": [{"role": "user", "content": "stream-smoke " + "context " * 8192}], "stream": True, "stream_options": {"include_usage": True}}
    request_bytes = json.dumps(original, separators=(",", ":")).encode()
    legacy_bytes = b'{"model":"fixture-alias","prompt":"legacy-smoke","stream":false}'
    followup_bytes = b""

    def remaining(limit=10):
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("The OMP smoke test reached its deadline.")
        return min(left, limit)

    def frame(value):
        return b"data: " + json.dumps(value, separators=(",", ":")).encode() + b"\n\n"

    first = frame({"choices": [{"index": 0, "delta": {"reasoning_content": "first-thought"}, "finish_reason": None}]})
    visible = frame({"choices": [{"index": 0, "delta": {"content": "converted-visible"}, "finish_reason": None}]})
    terminal = frame({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 5, "completion_tokens": 3, "total_tokens": 8}}) + b"data: [DONE]\n\n"
    def google(parts, finish=None):
        candidate = {"content": {"role": "model", "parts": parts}}
        response = {"candidates": [candidate]}
        if finish:
            candidate["finishReason"] = finish
            response["usageMetadata"] = {"promptTokenCount": 5, "candidatesTokenCount": 3, "totalTokenCount": 8}
        return frame({"response": response})

    if antigravity:
        first = google([{"text": "first-thought", "thought": True}])
        visible = google([{"text": "converted-visible", "thoughtSignature": signature}])
        terminal = google([], "STOP")

    class Origin(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def body(self):
            self.connection.settimeout(remaining())
            result = bytearray()
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                while True:
                    line = self.rfile.readline(8193)
                    require(line.endswith(b"\r\n") and len(line) <= 8192, "Invalid upstream chunk.")
                    size = int(line.split(b";", 1)[0], 16)
                    require(0 <= size <= 1048576 - len(result), "The upstream request is too large.")
                    if size == 0:
                        require(self.rfile.readline(8193) == b"\r\n", "Unexpected upstream trailers.")
                        break
                    data = self.rfile.read(size)
                    require(len(data) == size and self.rfile.read(2) == b"\r\n", "Truncated upstream request.")
                    result.extend(data)
            else:
                size = int(self.headers.get("Content-Length", "0"))
                require(0 < size <= 1048576, "Invalid upstream body size.")
                result.extend(self.rfile.read(size))
                require(len(result) == size, "Truncated upstream body.")
            return json.loads(result)

        def chunk(self, data):
            self.wfile.write(f"{len(data):X}\r\n".encode() + data + b"\r\n")
            self.wfile.flush()
            with raw_lock:
                raw_bytes[0] += len(data)

        def do_POST(self):
            try:
                expected_path = "/v1internal:streamGenerateContent?alt=sse" if antigravity else "/v1/chat/completions"
                require(self.path == expected_path, "The selected upstream route changed.")
                require(self.headers.get("Authorization") == "Bearer " + provider_key, "OMP did not use the server-only credential.")
                require(self.headers.get("Accept-Encoding") == "identity", "OMP did not select uncompressed raw response bytes.")
                for secret in (password, user_uuid, caller_key):
                    require(secret not in str(self.headers), "A caller credential reached the upstream.")
                body = self.body()
                if antigravity:
                    require(body.get("model") == "gemini-3.8-flash-low", "The remote AG model alias and effort tier were not resolved.")
                    require(self.headers.get("User-Agent") == "zproxy/AG2API", "The AG adapter did not identify its transport.")
                    require(body.get("project") == "smoke-project", "The selected account project was lost.")
                    require("messages" not in body and "_zproxy_ag" not in json.dumps(body), "A private request format reached the upstream.")
                    contents = body.get("request", {}).get("contents", [])
                else:
                    require(body.get("model") == "model", "The remote model alias was not resolved.")
                    require(body.get("stream") is True, "The remote OMP adapter did not request the raw stream.")
                    contents = body.get("messages")
                legacy = "legacy-smoke" in json.dumps(contents)
                followup = "followup-smoke" in json.dumps(contents)
                if followup:
                    require(any(part.get("thoughtSignature") == signature for item in contents
                                if item.get("role") == "model" for part in item.get("parts", [])),
                            "The next turn did not restore its matching local thought signature.")
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Transfer-Encoding", "chunked")
                self.send_header("Authorization", "Bearer " + provider_key)
                self.send_header("Set-Cookie", "provider=" + provider_key)
                self.send_header("X-Api-Key", provider_key)
                self.end_headers()
                if legacy:
                    with raw_lock:
                        legacy_started[0] += 1
                        if legacy_started[0] == legacy_count:
                            legacy_ready.set()
                    require(legacy_ready.wait(remaining(30)), "A provider or local codec concurrency cap blocked parallel requests.")
                    self.chunk(google([{"text": "legacy-result"}]) if antigravity else
                               frame({"choices": [{"index": 0, "delta": {"content": "legacy-result"}, "finish_reason": None}]}))
                elif followup:
                    self.chunk(google([{"text": "followup-result"}]))
                else:
                    self.chunk(first)
                    require(release.wait(remaining(30)), "Parsed reasoning did not reach the caller before upstream EOF.")
                    self.chunk(visible)
                    require(finish_stream.wait(remaining(30)), "Parsed visible text did not reach the caller before upstream EOF.")
                self.chunk(terminal)
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
                if not legacy and not followup:
                    origin_finished.set()
            except Exception as error:
                failures.put(str(error))
                self.close_connection = True

    origin = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Origin)
    origin.daemon_threads = True
    thread = threading.Thread(target=lambda: origin.serve_forever(poll_interval=0.05), daemon=True)
    thread.start()
    server_port, client_port, web_port = free_ports()
    processes, logs = [], []
    names = {"ZPROXY_OMP_SMOKE_ADMIN", "ZPROXY_OMP_SMOKE_UUID"}
    environment = {name: value for name, value in os.environ.items() if name not in names}
    phase = "preparing OMP fixtures"

    def stop(process, strict=False):
        children = descendants(process.pid)
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
        try:
            code = process.wait(timeout=remaining(12) if strict else 3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)
            if strict:
                raise RuntimeError("A native process did not stop after SIGTERM.")
            return
        if strict:
            require(code == 0, f"A native process exited with status {code}.")
            require(all(not Path(f"/proc/{pid}").exists() for pid in children), "An OMP child process survived shutdown.")

    def wait_listen(process, port):
        while True:
            require(process.poll() is None, "A native process exited during startup.")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=remaining(0.2)):
                    return
            except OSError:
                time.sleep(remaining(0.05))

    def web(method, path, body=None, cookie=None):
        headers = {"Origin": f"http://127.0.0.1:{web_port}"}
        if body is not None:
            body = json.dumps(body).encode()
            headers["Content-Type"] = "application/json"
        if cookie:
            headers["Cookie"] = cookie
        with contextlib.closing(http.client.HTTPConnection("127.0.0.1", web_port, timeout=remaining())) as connection:
            connection.request(method, path, body, headers)
            response = connection.getresponse()
            content = response.read(65537)
            require(len(content) <= 65536, "The management response is too large.")
            return response.status, dict(response.getheaders()), content

    def safe_headers(response):
        for name in ("Authorization", "Set-Cookie", "X-Api-Key", "X-Zproxy-Decode"):
            require(response.getheader(name) is None, "A private OMP header reached the caller.")
        require(provider_key not in str(response.getheaders()), "A provider credential reached the caller.")

    with tempfile.TemporaryDirectory(prefix="zproxy-omp-") as temporary:
        directory = Path(temporary)
        config = directory / "remote.json"
        models = directory / "models.yml"
        provider = "google-antigravity" if antigravity else "fixture"
        model_id = "gemini-3.8-flash" if antigravity else "model"
        models.write_text(json.dumps({"providers": {provider: {
            "baseUrl": f"http://127.0.0.1:{origin.server_port}" + ("" if antigravity else "/v1"),
            "api": "google-gemini-cli" if antigravity else "openai-completions",
            "apiKey": json.dumps({"token": provider_key, "projectId": "smoke-project"}) if antigravity else provider_key,
            "models": [{"id": model_id, "name": "Fixture", "reasoning": True, "input": ["text"], "contextWindow": 8192,
                        "maxTokens": 1024, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}]}}}))
        config.write_text(json.dumps({"version": 1, "authDatabase": str(directory / "auth.db"), "modelsFile": str(models),
                                     "modelCache": str(directory / "models.db"), "discovery": "offline",
                                     "antigravity2api": antigravity, "aliases": {"fixture-alias": f"{provider}/{model_id}"}}))
        models.chmod(0o600)
        config.chmod(0o600)
        try:
            def start(role, arguments, env):
                log = directory / f"{role}.log"
                logs.append(log)
                with log.open("wb") as output:
                    process = subprocess.Popen([str(binary), role, "--omp", "--omp-dir", str(omp_dir), "--max-streams", "16" if antigravity else "4", "--stream-window-bytes", "16384"] + arguments, env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)
                processes.append(process)
                return process

            phase = "starting the remote OMP worker"
            server = start("server", ["--listen", f"127.0.0.1:{server_port}", "--web-listen", f"127.0.0.1:{web_port}", "--omp-config", str(config), "--data-dir", str(directory / "data"), "--admin-password-env", "ZPROXY_OMP_SMOKE_ADMIN"], dict(environment, ZPROXY_OMP_SMOKE_ADMIN=password))
            wait_listen(server, server_port)
            wait_listen(server, web_port)
            status, headers, _ = web("POST", "/admin/login", {"password": password})
            require(status == 200, "The administrator could not unlock user management.")
            cookies = http.cookies.SimpleCookie()
            cookies.load(headers.get("Set-Cookie", ""))
            require("zproxy-admin" in cookies, "The administrator cookie is missing.")
            status, _, data = web("POST", "/admin/api/users", {"nickname": nickname}, "zproxy-admin=" + cookies["zproxy-admin"].value)
            require(status == 201, "The administrator could not create a user.")
            issued = json.loads(data)
            user_uuid, user_id = issued["uuid"], issued["user"]["id"]
            phase = "starting the local OMP decoder"
            client_env = dict(environment, ZPROXY_OMP_SMOKE_UUID=user_uuid)
            require(provider_key not in client_env.values() and password not in client_env.values(), "The client has server credentials.")
            client = start("client", ["--listen", f"127.0.0.1:{client_port}", "--server", f"http://127.0.0.1:{server_port}", "--uuid-env", "ZPROXY_OMP_SMOKE_UUID"], client_env)
            wait_listen(client, client_port)
            require(descendants(client.pid) and descendants(server.pid), "An OMP worker did not start.")
            caller_headers = {"Authorization": "Bearer " + user_uuid, "Content-Type": "application/json", "X-Api-Key": caller_key, "Cookie": "caller=" + caller_key}
            with contextlib.closing(http.client.HTTPConnection("127.0.0.1", client_port, timeout=remaining(20))) as connection:
                phase = "receiving locally parsed reasoning before upstream EOF"
                chunks = (request_bytes[index:index + 4096] for index in range(0, len(request_bytes), 4096))
                connection.request("POST", "/v1/chat/completions", chunks, caller_headers, encode_chunked=True)
                response = connection.getresponse()
                require(response.status == 200, f"The streamed completion returned {response.status}.")
                safe_headers(response)
                received = bytearray()
                while b"first-thought" not in received:
                    line = response.readline(65537)
                    require(line and len(received) + len(line) <= 65536, "No bounded reasoning event arrived.")
                    received.extend(line)
                require(not origin_finished.is_set(), "The response was buffered until upstream EOF.")
                require(b'"role":"assistant"' in received and b'"model":"fixture-alias"' in received, "The official local OpenAI encoder did not run.")
                phase = "decoding concurrent nonstream legacy completions"
                def legacy_probe():
                    with contextlib.closing(http.client.HTTPConnection("127.0.0.1", client_port, timeout=remaining(30))) as concurrent:
                        concurrent.request("POST", "/v1/completions", legacy_bytes, caller_headers)
                        probe = concurrent.getresponse()
                        require(probe.status == 200, "The concurrent legacy completion failed.")
                        safe_headers(probe)
                        value = json.loads(probe.read(65537))
                        require(value["object"] == "text_completion" and value["choices"][0]["text"] == "legacy-result", "The local legacy response conversion failed.")
                        require(value["usage"]["total_tokens"] == 8, "The local parser lost usage.")
                with concurrent.futures.ThreadPoolExecutor(max_workers=legacy_count) as pool:
                    jobs = [pool.submit(legacy_probe) for _ in range(legacy_count)]
                    for job in jobs:
                        job.result(timeout=remaining(35))
                release.set()
                phase = "receiving locally parsed visible text before upstream EOF"
                while b"converted-visible" not in received:
                    line = response.readline(65537)
                    require(line and len(received) + len(line) <= 65536, "No bounded visible event arrived.")
                    received.extend(line)
                require(not origin_finished.is_set(), "Visible text was buffered until upstream EOF.")
                finish_stream.set()
                phase = "finishing the decoded SSE response"
                received.extend(response.read(1048577))
                require(len(received) <= 1048576 and b"converted-visible" in received and b"data: [DONE]" in received, "The decoded response did not finish.")
                require(provider_key.encode() not in received, "A provider credential reached the response body.")
            require(origin_finished.wait(remaining()), "The upstream fixture did not finish.")
            if antigravity:
                phase = "restoring a matching thought signature on the next turn"
                followup_bytes = json.dumps({"model": "fixture-alias", "messages": original["messages"] + [
                    {"role": "assistant", "content": "converted-visible"}, {"role": "user", "content": "followup-smoke"}],
                    "stream": False}, separators=(",", ":")).encode()
                with contextlib.closing(http.client.HTTPConnection("127.0.0.1", client_port, timeout=remaining(20))) as connection:
                    connection.request("POST", "/v1/chat/completions", followup_bytes, caller_headers)
                    response = connection.getresponse()
                    require(response.status == 200, "The signature followup failed.")
                    safe_headers(response)
                    value = json.loads(response.read(65537))
                    require(value["choices"][0]["message"]["content"] == "followup-result", "The followup was not decoded locally.")
            require(failures.empty(), "The upstream fixture reported a failure.")
            total = 1 + legacy_count + bool(followup_bytes)
            phase = "checking the public nickname report and raw byte counts"
            while True:
                status, _, data = web("GET", "/api/reports")
                require(status == 200, "The public report required authentication.")
                rows = json.loads(data)["users"]
                require(len(rows) == 1 and rows[0]["nickname"] == nickname, "The nickname report changed.")
                row = rows[0]
                for secret in (user_uuid, user_id, password, provider_key, caller_key):
                    require(secret.encode() not in data, "A public report exposed private identity or credentials.")
                if row["requests"] == total and row["active"] == 0:
                    break
                time.sleep(remaining(0.02))
            require(row["succeeded"] == total and row["failed"] == 0, "The report did not record all completions.")
            original_size = len(request_bytes) + legacy_count * len(legacy_bytes) + len(followup_bytes)
            if antigravity:
                require(original_size < row["requestBytes"] < original_size + 4096, "The request count did not include bounded private signature metadata.")
            else:
                require(row["requestBytes"] == original_size, "The request byte count changed.")
            require(row["responseBytes"] == raw_bytes[0], "The report did not count the remote raw response bytes.")
            phase = "stopping native processes and their OMP workers"
            stop(client, True)
            stop(server, True)
            print(("AG2API" if antigravity else "OMP") + " smoke passed: real remote gateway, server-only credentials, local parsing before upstream EOF, "
                  + ("six concurrent legacy conversions, next-turn signature recovery, " if antigravity else "concurrent legacy conversion, ")
                  + "usage, nickname reports, raw-byte accounting, and worker cleanup.")
        except Exception:
            print("Phase:", phase)
            for log in logs:
                content = log.read_text(errors="replace")[-8000:]
                for secret in (password, provider_key, caller_key, user_uuid):
                    if secret:
                        content = content.replace(secret, "[redacted]")
                print(log.name + ":\n" + content)
            while not failures.empty():
                print("Origin:", failures.get_nowait())
            raise
        finally:
            release.set()
            finish_stream.set()
            legacy_ready.set()
            for process in reversed(processes):
                stop(process)
            origin.shutdown()
            origin.server_close()
            thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--omp-dir", type=Path, default=Path(__file__).resolve().parents[1] / "plugins" / "omp")
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--antigravity2api", action="store_true", help="Use the pinned AG Go codec and verify concurrent streams and signature recovery.")
    args = parser.parse_args()
    binary, omp_dir = args.binary.resolve(), args.omp_dir.resolve()
    require(binary.is_file() and os.access(binary, os.X_OK), "--binary must be an executable file.")
    require((omp_dir / "local.mjs").is_file() and (omp_dir / "remote.mjs").is_file(), "--omp-dir must contain both workers.")
    require(10 <= args.timeout <= 600, "--timeout must be between 10 and 600 seconds.")
    if args.antigravity2api:
        require((omp_dir / "bin" / "zproxy-ag").is_file(), "The AG2API smoke requires the bundled Go codec.")
    run(binary, omp_dir, args.timeout, args.antigravity2api)


if __name__ == "__main__":
    main()
