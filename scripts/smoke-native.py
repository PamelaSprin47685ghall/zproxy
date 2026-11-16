#!/usr/bin/env python3
"""Check the published Linux executable using loopback traffic only."""

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
import uuid


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def choose_ports():
    with contextlib.ExitStack() as stack:
        sockets = [stack.enter_context(socket.socket()) for _ in range(3)]
        for connection in sockets:
            connection.bind(("127.0.0.1", 0))
        return [connection.getsockname()[1] for connection in sockets]


def run(binary, timeout):
    deadline = time.monotonic() + timeout
    release = threading.Event()
    finished = threading.Event()
    origin_errors = queue.Queue()
    master_password = secrets.token_urlsafe(32)
    gateway_token = secrets.token_urlsafe(32)
    caller_token = secrets.token_urlsafe(32)
    user_uuid = ""
    nickname = "Native smoke 用户"
    payload = json.dumps({
        "model": "native-smoke",
        "messages": [{"role": "user", "content": "context " * 16384}],
        "stream": True,
    }, separators=(",", ":")).encode()
    first = b'data: {"choices":[{"delta":{"content":"first"}}]}\n\n'
    second = b'data: {"choices":[{"delta":{"content":"' + b"x" * 32768 + b'"}}]}\n\n'
    tail = second + b"data: [DONE]\n\n"
    completion_payload = b'{"model":"native-smoke","prompt":"probe","stream":false}'
    completion_response = b'{"choices":[{"text":"ok"}]}'

    def remaining(limit=5):
        left = deadline - time.monotonic()
        if left <= 0:
            raise TimeoutError("The native smoke test reached its deadline.")
        return min(limit, left)

    class Origin(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def body(self):
            self.connection.settimeout(remaining())
            if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
                data = bytearray()
                while True:
                    line = self.rfile.readline(8193)
                    require(line.endswith(b"\r\n") and len(line) <= 8192, "Invalid origin chunk line.")
                    count = int(line.split(b";", 1)[0], 16)
                    require(0 <= count <= 1048576 - len(data), "Origin body exceeds its bound.")
                    if count == 0:
                        require(self.rfile.readline(8193) == b"\r\n", "Unexpected origin trailer.")
                        return bytes(data)
                    block = self.rfile.read(count)
                    require(len(block) == count and self.rfile.read(2) == b"\r\n", "Truncated origin chunk.")
                    data.extend(block)
            count = int(self.headers.get("Content-Length", "0"))
            require(0 <= count <= 1048576, "Origin body exceeds its bound.")
            data = self.rfile.read(count)
            require(len(data) == count, "Truncated origin body.")
            return data

        def check_headers(self):
            require(self.headers.get("Authorization") == "Bearer " + gateway_token, "The server did not inject its gateway credential.")
            require(self.headers.get("Accept-Encoding") == "identity", "The default origin encoding changed.")
            for name in ("Cookie", "X-Api-Key", "Proxy-Authorization"):
                require(self.headers.get(name) is None, "A local credential reached the gateway.")
            for secret in (master_password, user_uuid, caller_token):
                require(secret and secret not in str(self.headers), "A private caller or admin credential reached the gateway.")

        def response_headers(self):
            self.send_header("Authorization", "Bearer " + gateway_token)
            self.send_header("Set-Cookie", "upstream-session=" + gateway_token)
            self.send_header("X-Api-Key", gateway_token)
            self.send_header("X-Provider-Account", gateway_token)

        def chunk(self, data):
            self.wfile.write(f"{len(data):X}\r\n".encode() + data + b"\r\n")
            self.wfile.flush()

        def do_POST(self):
            try:
                self.check_headers()
                if self.path == "/v1/chat/completions":
                    require(self.headers.get("Transfer-Encoding", "").lower() == "chunked", "The streamed upload lost chunked framing.")
                    require(self.body() == payload, "The request body changed.")
                    self.send_response(200)
                    self.response_headers()
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    self.chunk(first)
                    require(release.wait(remaining(15)), "The first SSE event did not reach the caller.")
                    self.chunk(second)
                    self.chunk(b"data: [DONE]\n\n")
                    self.wfile.write(b"0\r\n\r\n")
                    self.wfile.flush()
                    finished.set()
                else:
                    require(self.path == "/v1/completions", "The concurrent request path changed.")
                    require(self.body() == completion_payload, "The concurrent body changed.")
                    self.send_response(200)
                    self.response_headers()
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(completion_response)))
                    self.end_headers()
                    self.wfile.write(completion_response)
                    self.wfile.flush()
            except Exception as error:
                origin_errors.put(str(error))
                self.close_connection = True

    origin = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Origin)
    origin.daemon_threads = True
    origin_thread = threading.Thread(target=lambda: origin.serve_forever(poll_interval=0.05), daemon=True)
    origin_thread.start()
    server_port, client_port, web_port = choose_ports()
    admin_name = "ZPROXY_NATIVE_SMOKE_ADMIN_PASSWORD"
    gateway_name = "ZPROXY_NATIVE_SMOKE_GATEWAY_TOKEN"
    uuid_name = "ZPROXY_NATIVE_SMOKE_USER_UUID"
    environment = {name: value for name, value in os.environ.items()
                   if name not in (admin_name, gateway_name, uuid_name)}
    server_environment = dict(environment, **{admin_name: master_password, gateway_name: gateway_token})
    processes = []

    def stop(process, strict):
        if process.poll() is None:
            process.send_signal(signal.SIGTERM)
        try:
            code = process.wait(timeout=remaining(10) if strict else 3)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=3)
            if strict:
                raise RuntimeError("The native process did not stop after SIGTERM.")
            return
        if strict:
            require(code == 0, f"The native process exited with status {code}.")

    def wait_listen(process, port, name):
        while True:
            require(process.poll() is None, f"The native {name} exited before it listened.")
            try:
                with socket.create_connection(("127.0.0.1", port), timeout=remaining(0.2)):
                    return
            except OSError:
                time.sleep(remaining(0.05))

    def web(method, path, body=None, cookie=None):
        headers = {}
        if body is not None:
            body = json.dumps(body, separators=(",", ":")).encode()
            headers["Content-Type"] = "application/json"
        if method != "GET":
            headers["Origin"] = f"http://127.0.0.1:{web_port}"
        if cookie:
            headers["Cookie"] = cookie
        with contextlib.closing(http.client.HTTPConnection("127.0.0.1", web_port, timeout=remaining())) as connection:
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            content = response.read(65537)
            require(len(content) <= 65536, "The management response exceeded its bound.")
            return response.status, dict(response.getheaders()), content

    def check_response_headers(response):
        for name in ("Authorization", "Set-Cookie", "X-Api-Key", "X-Provider-Account"):
            require(response.getheader(name) is None, "A sensitive gateway response header reached the client.")
        require(gateway_token not in str(response.getheaders()), "The client received the gateway credential.")

    def expired(*_):
        raise TimeoutError("The native smoke test reached its deadline.")

    previous_alarm = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, timeout)
    with tempfile.TemporaryDirectory(prefix="zproxy-native-") as temporary:
        logs = []
        phase = "starting native processes"
        try:
            def start(name, arguments, process_environment):
                log = Path(temporary) / f"{name}.log"
                logs.append(log)
                with log.open("wb") as output:
                    process = subprocess.Popen(
                        [str(binary), name, "--max-streams", "2", "--stream-window-bytes", "16384"] + arguments,
                        env=process_environment, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                    )
                processes.append(process)
                return process

            server = start("server", [
                "--listen", f"127.0.0.1:{server_port}", "--web-listen", f"127.0.0.1:{web_port}",
                "--admin-password-env", admin_name, "--gateway-token-env", gateway_name,
                "--gateway", f"http://127.0.0.1:{origin.server_port}",
                "--data-dir", str(Path(temporary) / "data"), "--max-tunnels", "4",
            ], server_environment)
            wait_listen(server, server_port, "server")
            wait_listen(server, web_port, "management server")
            phase = "creating a user through the password-protected admin API"
            status, login_headers, _ = web("POST", "/admin/login", {"password": master_password})
            require(status == 200, "The admin password did not unlock management.")
            cookies = http.cookies.SimpleCookie()
            cookies.load(login_headers.get("Set-Cookie", ""))
            require("zproxy-admin" in cookies, "The admin session cookie is missing.")
            cookie = "zproxy-admin=" + cookies["zproxy-admin"].value
            status, _, body = web("POST", "/admin/api/users", {"nickname": nickname}, cookie)
            require(status == 201, "The admin API did not create the user.")
            issued = json.loads(body)
            user_uuid, user_id = issued["uuid"], issued["user"]["id"]
            require(uuid.UUID(user_uuid).version == 4, "The issued user credential is not a random UUID.")
            status, _, _ = web("POST", "/admin/login", {"password": user_uuid})
            require(status == 401, "A user UUID unlocked admin management.")
            status, _, body = web("GET", "/admin/api/users", cookie=cookie)
            require(status == 200 and user_uuid.encode() not in body, "The admin list exposed the one-time UUID.")

            client_environment = dict(environment, **{uuid_name: user_uuid})
            require(master_password not in client_environment.values() and gateway_token not in client_environment.values(),
                    "The client environment contains a server credential.")
            client = start("client", [
                "--listen", f"127.0.0.1:{client_port}", "--server", f"http://127.0.0.1:{server_port}",
                "--uuid-env", uuid_name,
            ], client_environment)
            wait_listen(client, client_port, "client")
            headers = {"Authorization": "Bearer " + user_uuid, "Content-Type": "application/json",
                       "X-Api-Key": caller_token, "Cookie": "caller-session=" + caller_token}

            with contextlib.closing(http.client.HTTPConnection("127.0.0.1", client_port, timeout=remaining())) as request:
                phase = "uploading the request and receiving response headers"
                chunks = (payload[offset:offset + 8192] for offset in range(0, len(payload), 8192))
                request.request("POST", "/v1/chat/completions", body=chunks, headers=headers, encode_chunked=True)
                response = request.getresponse()
                require(response.status == 200, f"Unexpected SSE status {response.status}.")
                require(response.getheader("Content-Type", "").startswith("text/event-stream"), "The SSE content type changed.")
                check_response_headers(response)
                phase = "receiving the first SSE event"
                require(response.read(len(first)) == first, "The first SSE event changed.")
                require(not finished.is_set(), "The SSE response was buffered to completion.")

                with contextlib.closing(http.client.HTTPConnection("127.0.0.1", client_port, timeout=remaining())) as concurrent:
                    phase = "completing a concurrent request"
                    concurrent.request("POST", "/v1/completions", body=completion_payload, headers=headers)
                    probe = concurrent.getresponse()
                    require(probe.status == 200 and probe.read(len(completion_response) + 1) == completion_response,
                            "The active SSE request blocked another request.")
                    check_response_headers(probe)
                    probe.close()

                release.set()
                phase = "receiving the SSE tail"
                request.sock.settimeout(remaining())
                require(response.read(len(tail) + 1) == tail, "The SSE tail changed or did not finish.")
                response.close()
                require(finished.wait(remaining()), "The origin did not finish its response.")

            require(origin_errors.empty(), "The origin reported an error.")
            phase = "checking the public per-user report"
            expected_fields = {"nickname", "requests", "succeeded", "failed", "canceled", "active",
                               "requestBytes", "responseBytes", "durationMs"}
            while True:
                status, _, body = web("GET", "/api/reports")
                require(status == 200, "The public report required a login.")
                report = json.loads(body)
                require(set(report) == {"users"} and len(report["users"]) == 1, "The public report shape changed.")
                row = report["users"][0]
                require(set(row) == expected_fields and row["nickname"] == nickname,
                        "The public report exposed identifiers or lost the nickname.")
                for secret in (user_uuid, user_id, master_password, gateway_token, caller_token):
                    require(secret.encode() not in body, "The public report exposed a credential or identifier.")
                if row["active"] == 0 and row["requests"] == 2:
                    break
                time.sleep(remaining(0.02))
            require(row["succeeded"] == 2 and row["failed"] == 0 and row["canceled"] == 0, "The user result counters changed.")
            require(row["requestBytes"] == len(payload) + len(completion_payload), "The user upload count changed.")
            require(row["responseBytes"] == len(first) + len(tail) + len(completion_response), "The user download count changed.")
            status, _, body = web("GET", "/reports")
            require(status == 200 and b"textContent" in body and b"innerHTML" not in body, "The public report page is unavailable or unsafe.")
            for secret in (user_uuid, user_id, master_password, gateway_token, caller_token):
                require(secret.encode() not in body, "The public report page exposed a credential or identifier.")
            phase = "stopping the native client"
            stop(client, True)
            phase = "stopping the native server"
            stop(server, True)
            print("Native smoke passed: admin-issued UUID, remote credentials, public reports, chunked upload, streamed SSE, byte credit, concurrency, and SIGTERM cleanup.")
        except Exception:
            print("Phase:", phase)
            for log in logs:
                print(f"--- {log.name} ---")
                content = log.read_text(errors="replace")[-8000:]
                for secret in (master_password, gateway_token, caller_token, user_uuid):
                    if secret:
                        content = content.replace(secret, "[redacted]")
                print(content)
            while not origin_errors.empty():
                print("Origin:", origin_errors.get_nowait())
            raise
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous_alarm)
            release.set()
            for process in reversed(processes):
                stop(process, False)
            origin.shutdown()
            origin.server_close()
            origin_thread.join(timeout=2)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--timeout", type=float, default=60)
    arguments = parser.parse_args()
    binary = arguments.binary.resolve()
    if not binary.is_file() or not os.access(binary, os.X_OK):
        parser.error("--binary must be an executable file.")
    if not 0 < arguments.timeout <= 300:
        parser.error("--timeout must be greater than 0 and at most 300 seconds.")
    try:
        run(binary, arguments.timeout)
    except Exception as error:
        parser.exit(1, f"Native smoke failed: {error}\n")


if __name__ == "__main__":
    main()
