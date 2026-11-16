#!/usr/bin/env python3
"""Check the native OMP bridge and bundled workers with owned loopback traffic."""

import argparse
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


def run(binary, omp_dir, timeout):
    deadline = time.monotonic() + timeout
    password, provider_key, caller_key = (secrets.token_urlsafe(32) for _ in range(3))
    user_uuid = ""
    nickname = "OMP smoke 用户"
    release = threading.Event()
    origin_finished = threading.Event()
    failures = queue.Queue()
    raw_bytes = [0]
    raw_lock = threading.Lock()
    request_bytes = json.dumps({"model": "fixture-alias", "messages": [{"role": "user", "content": "stream-smoke " + "context " * 8192}], "stream": True, "stream_options": {"include_usage": True}}, separators=(",", ":")).encode()
    legacy_bytes = b'{"model":"fixture-alias","prompt":"legacy-smoke","stream":false}'

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
                require(self.path == "/v1/chat/completions", "The official OMP upstream route changed.")
                require(self.headers.get("Authorization") == "Bearer " + provider_key, "OMP did not use the server-only credential.")
                require(self.headers.get("Accept-Encoding") == "identity", "OMP did not select uncompressed raw response bytes.")
                for secret in (password, user_uuid, caller_key):
                    require(secret not in str(self.headers), "A caller credential reached the upstream.")
                body = self.body()
                require(body.get("model") == "model", "The remote model alias was not resolved.")
                require(body.get("stream") is True, "The remote OMP adapter did not request the raw stream.")
                legacy = "legacy-smoke" in json.dumps(body.get("messages"))
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Transfer-Encoding", "chunked")
                self.send_header("Authorization", "Bearer " + provider_key)
                self.send_header("Set-Cookie", "provider=" + provider_key)
                self.send_header("X-Api-Key", provider_key)
                self.end_headers()
                if legacy:
                    self.chunk(frame({"choices": [{"index": 0, "delta": {"content": "legacy-result"}, "finish_reason": None}]}))
                else:
                    self.chunk(first)
                    require(release.wait(remaining(30)), "Parsed reasoning did not reach the caller before upstream EOF.")
                    self.chunk(visible)
                self.chunk(terminal)
                self.wfile.write(b"0\r\n\r\n")
                self.wfile.flush()
                if not legacy:
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
        models.write_text(json.dumps({"providers": {"fixture": {"baseUrl": f"http://127.0.0.1:{origin.server_port}/v1", "api": "openai-completions", "apiKey": provider_key, "models": [{"id": "model", "name": "Fixture", "reasoning": True, "input": ["text"], "contextWindow": 8192, "maxTokens": 1024, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}]}}}))
        config.write_text(json.dumps({"version": 1, "authDatabase": str(directory / "auth.db"), "modelsFile": str(models), "modelCache": str(directory / "models.db"), "discovery": "offline", "aliases": {"fixture-alias": "fixture/model"}}))
        models.chmod(0o600)
        config.chmod(0o600)
        try:
            def start(role, arguments, env):
                log = directory / f"{role}.log"
                logs.append(log)
                with log.open("wb") as output:
                    process = subprocess.Popen([str(binary), role, "--omp", "--omp-dir", str(omp_dir), "--max-streams", "4", "--stream-window-bytes", "16384"] + arguments, env=env, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT)
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
                phase = "decoding a concurrent nonstream legacy completion"
                with contextlib.closing(http.client.HTTPConnection("127.0.0.1", client_port, timeout=remaining(20))) as concurrent:
                    concurrent.request("POST", "/v1/completions", legacy_bytes, caller_headers)
                    probe = concurrent.getresponse()
                    require(probe.status == 200, "The concurrent legacy completion failed.")
                    safe_headers(probe)
                    value = json.loads(probe.read(65537))
                    require(value["object"] == "text_completion" and value["choices"][0]["text"] == "legacy-result", "The local legacy response conversion failed.")
                    require(value["usage"]["total_tokens"] == 8, "The local parser lost usage.")
                release.set()
                phase = "finishing the decoded SSE response"
                received.extend(response.read(1048577))
                require(len(received) <= 1048576 and b"converted-visible" in received and b"data: [DONE]" in received, "The decoded response did not finish.")
                require(provider_key.encode() not in received, "A provider credential reached the response body.")
            require(origin_finished.wait(remaining()), "The upstream fixture did not finish.")
            require(failures.empty(), "The upstream fixture reported a failure.")
            phase = "checking the public nickname report and raw byte counts"
            while True:
                status, _, data = web("GET", "/api/reports")
                require(status == 200, "The public report required authentication.")
                rows = json.loads(data)["users"]
                require(len(rows) == 1 and rows[0]["nickname"] == nickname, "The nickname report changed.")
                row = rows[0]
                for secret in (user_uuid, user_id, password, provider_key, caller_key):
                    require(secret.encode() not in data, "A public report exposed private identity or credentials.")
                if row["requests"] == 2 and row["active"] == 0:
                    break
                time.sleep(remaining(0.02))
            require(row["succeeded"] == 2 and row["failed"] == 0, "The report did not record both completions.")
            require(row["requestBytes"] == len(request_bytes) + len(legacy_bytes), "The request byte count changed.")
            require(row["responseBytes"] == raw_bytes[0], "The report did not count the remote raw response bytes.")
            phase = "stopping native processes and their OMP workers"
            stop(client, True)
            stop(server, True)
            print("OMP smoke passed: real remote gateway, server-only credentials, local official parsing before upstream EOF, concurrent legacy conversion, usage, nickname reports, raw-byte accounting, and worker cleanup.")
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
    args = parser.parse_args()
    binary, omp_dir = args.binary.resolve(), args.omp_dir.resolve()
    require(binary.is_file() and os.access(binary, os.X_OK), "--binary must be an executable file.")
    require((omp_dir / "local.mjs").is_file() and (omp_dir / "remote.mjs").is_file(), "--omp-dir must contain both workers.")
    require(10 <= args.timeout <= 600, "--timeout must be between 10 and 600 seconds.")
    run(binary, omp_dir, args.timeout)


if __name__ == "__main__":
    main()
