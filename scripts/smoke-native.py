#!/usr/bin/env python3
"""Check the published Linux executable using loopback traffic only."""

import argparse
import contextlib
import http.client
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


def choose_ports():
    with contextlib.ExitStack() as stack:
        sockets = [stack.enter_context(socket.socket()) for _ in range(2)]
        for connection in sockets:
            connection.bind(("127.0.0.1", 0))
        return [connection.getsockname()[1] for connection in sockets]


def run(binary, timeout):
    deadline = time.monotonic() + timeout
    release = threading.Event()
    finished = threading.Event()
    origin_errors = queue.Queue()
    payload = json.dumps({
        "model": "native-smoke",
        "messages": [{"role": "user", "content": "context " * 16384}],
        "stream": True,
    }, separators=(",", ":")).encode()
    first = b'data: {"choices":[{"delta":{"content":"first"}}]}\n\n'
    second = b'data: {"choices":[{"delta":{"content":"' + b"x" * 32768 + b'"}}]}\n\n'
    tail = second + b"data: [DONE]\n\n"

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
            require(self.headers.get("Authorization") == "Bearer native-smoke", "Authorization did not reach the origin.")
            require(self.headers.get("Accept-Encoding") == "identity", "The default origin encoding changed.")

        def chunk(self, data):
            self.wfile.write(f"{len(data):X}\r\n".encode() + data + b"\r\n")
            self.wfile.flush()

        def do_POST(self):
            try:
                require(self.path == "/v1/chat/completions", "The origin request path changed.")
                self.check_headers()
                require(self.body() == payload, "The request body changed.")
                self.send_response(200)
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
            except Exception as error:
                origin_errors.put(str(error))
                self.close_connection = True

        def do_GET(self):
            try:
                require(self.path == "/probe", "The concurrent request path changed.")
                self.check_headers()
                self.send_response(200)
                self.send_header("Content-Length", "2")
                self.end_headers()
                self.wfile.write(b"ok")
                self.wfile.flush()
            except Exception as error:
                origin_errors.put(str(error))
                self.close_connection = True

    origin = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Origin)
    origin.daemon_threads = True
    origin_thread = threading.Thread(target=lambda: origin.serve_forever(poll_interval=0.05), daemon=True)
    origin_thread.start()
    server_port, client_port = choose_ports()
    password_name = "ZPROXY_NATIVE_SMOKE_PASSWORD"
    environment = dict(os.environ)
    environment[password_name] = secrets.token_urlsafe(32)
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

    def expired(*_):
        raise TimeoutError("The native smoke test reached its deadline.")

    previous_alarm = signal.signal(signal.SIGALRM, expired)
    signal.setitimer(signal.ITIMER_REAL, timeout)
    with tempfile.TemporaryDirectory(prefix="zproxy-native-") as temporary:
        logs = []
        phase = "starting native processes"
        try:
            def start(name, arguments):
                log = Path(temporary) / f"{name}.log"
                logs.append(log)
                with log.open("wb") as output:
                    process = subprocess.Popen(
                        [str(binary), name, "--password-env", password_name,
                         "--max-streams", "2", "--stream-window-bytes", "16384"] + arguments,
                        env=environment, stdin=subprocess.DEVNULL, stdout=output, stderr=subprocess.STDOUT,
                    )
                processes.append(process)
                return process

            server = start("server", ["--listen", f"127.0.0.1:{server_port}", "--max-tunnels", "4"])
            wait_listen(server, server_port, "server")
            client = start("client", ["--listen", f"127.0.0.1:{client_port}", "--server", f"http://127.0.0.1:{server_port}"])
            wait_listen(client, client_port, "client")
            prefix = f"/http://127.0.0.1:{origin.server_port}"
            headers = {"Authorization": "Bearer native-smoke", "Content-Type": "application/json"}

            with contextlib.closing(http.client.HTTPConnection("127.0.0.1", client_port, timeout=remaining())) as request:
                phase = "uploading the request and receiving response headers"
                request.request("POST", prefix + "/v1/chat/completions", body=payload, headers=headers)
                response = request.getresponse()
                require(response.status == 200, f"Unexpected SSE status {response.status}.")
                require(response.getheader("Content-Type", "").startswith("text/event-stream"), "The SSE content type changed.")
                phase = "receiving the first SSE event"
                require(response.read(len(first)) == first, "The first SSE event changed.")
                require(not finished.is_set(), "The SSE response was buffered to completion.")

                with contextlib.closing(http.client.HTTPConnection("127.0.0.1", client_port, timeout=remaining())) as concurrent:
                    phase = "completing a concurrent request"
                    concurrent.request("GET", prefix + "/probe", headers=headers)
                    probe = concurrent.getresponse()
                    require(probe.status == 200 and probe.read(3) == b"ok", "The active SSE request blocked another request.")
                    probe.close()

                release.set()
                phase = "receiving the SSE tail"
                request.sock.settimeout(remaining())
                require(response.read(len(tail) + 1) == tail, "The SSE tail changed or did not finish.")
                response.close()
                require(finished.wait(remaining()), "The origin did not finish its response.")

            require(origin_errors.empty(), "The origin reported an error.")
            phase = "stopping the native client"
            stop(client, True)
            phase = "stopping the native server"
            stop(server, True)
            print("Native smoke passed: streamed SSE, byte credit, concurrent request, and SIGTERM cleanup.")
        except Exception:
            print("Phase:", phase)
            for log in logs:
                print(f"--- {log.name} ---")
                print(log.read_text(errors="replace")[-8000:])
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
