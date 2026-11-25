#!/usr/bin/env python3
"""Check the native OMP bridge and bundled workers with owned upstream fixtures.

The ordinary mode uses a private loopback HTTP fixture. The optional Antigravity
mode runs the whole smoke inside a fresh user, mount, and network namespace: the
official Go HTTPS endpoints keep their fixed names and normal certificate checks,
while a bind-mounted hosts file and a bind-mounted CA bundle point those names at
an owned TLS fixture on an isolated loopback address. No test account, host
network, or host trust store is read.
"""

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
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

HOSTS_ADDRESS = "203.0.113.1"
OFFICIAL_BASE = "https://daily-cloudcode-pa.googleapis.com"
OFFICIAL_DOMAINS = (
    "cloudcode-pa.googleapis.com",
    "daily-cloudcode-pa.googleapis.com",
    "businessaicode.googleapis.com",
    "aicode.googleapis.com",
    "www.googleapis.com",
    "play.googleapis.com",
    "storage.googleapis.com",
    "raw.githubusercontent.com",
    "open-vsx.org",
    "marketplace.visualstudio.com",
    "accounts.google.com",
    "oauth2.googleapis.com",
    "antigravity.google",
    "*.googleusercontent.com",
)
# Go's Linux system-root search order. The fixture mounts its own bundle over the
# first path that exists, so crypto/x509 reads only the generated root.
CA_PATHS = (
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/pki/tls/certs/ca-bundle.crt",
    "/etc/ssl/ca-bundle.pem",
    "/etc/pki/tls/cacert.pem",
    "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
    "/etc/ssl/cert.pem",
)
# The account catalog entry the owned fixture serves for the modeled wire id.
OFFICIAL_MODEL = "gemini-3.8-flash-low"
OFFICIAL_MODEL_ENUM = "MODEL_PLACEHOLDER_M320"


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


def tool(name):
    path = shutil.which(name)
    if path is None:
        raise RuntimeError(f"The Antigravity smoke requires the Linux {name} command.")
    return path


def invoke(*arguments, note):
    try:
        result = subprocess.run(arguments, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True)
    except FileNotFoundError as error:
        raise RuntimeError(f"{arguments[0]} is required for the isolated fixture: {error}") from error
    if result.returncode != 0:
        detail = result.stderr.strip()[-2000:] or result.stdout.strip()[-2000:]
        raise RuntimeError(f"{note}: {detail}")
    return result


def generate_tls(directory):
    """Create one owned root CA and one server certificate for the fixed names."""
    openssl = tool("openssl")
    root_key, root_cert = directory / "root.key", directory / "root.pem"
    server_key, server_csr, server_cert = directory / "server.key", directory / "server.csr", directory / "server.pem"
    extension = directory / "server.ext"
    extension.write_text("basicConstraints=critical,CA:FALSE\n"
                         "keyUsage=critical,digitalSignature,keyEncipherment\n"
                         "extendedKeyUsage=serverAuth\n"
                         "subjectAltName=" + ",".join("DNS:" + domain for domain in OFFICIAL_DOMAINS) + "\n")
    invoke(openssl, "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-nodes", "-days", "2",
           "-keyout", str(root_key), "-out", str(root_cert),
           "-subj", "/CN=zproxy owned smoke root", note="openssl could not create the fixture root CA")
    invoke(openssl, "req", "-newkey", "rsa:2048", "-sha256", "-nodes",
           "-keyout", str(server_key), "-out", str(server_csr),
           "-subj", f"/CN={OFFICIAL_MODEL}", note="openssl could not create the fixture server key")
    invoke(openssl, "x509", "-req", "-sha256", "-days", "2", "-in", str(server_csr),
           "-CA", str(root_cert), "-CAkey", str(root_key), "-CAcreateserial",
           "-out", str(server_cert), "-extfile", str(extension),
           note="openssl could not sign the fixture server certificate")
    bundle = directory / "ca.pem"
    bundle.write_bytes(root_cert.read_bytes())
    for path in (root_key, root_cert, server_csr, extension):
        path.unlink()
    server_key.chmod(0o600)
    return server_cert, server_key, bundle


def write_hosts(directory):
    path = directory / "hosts"
    names = " ".join(domain for domain in OFFICIAL_DOMAINS if not domain.startswith("*."))
    path.write_text(f"# zproxy AG fixture\n{HOSTS_ADDRESS} {names}\n")
    path.chmod(0o644)
    return path


def ca_target():
    for candidate in CA_PATHS:
        if Path(candidate).exists():
            return os.path.realpath(candidate)
    raise RuntimeError("This Linux system has none of Go's default CA bundle paths, so the isolated "
                       "fixture cannot mount its own root without touching the host trust store.")


def require_namespaces():
    require(sys.platform.startswith("linux"), "The Antigravity smoke requires Linux namespaces.")
    unshare = shutil.which("unshare")
    if unshare is None:
        raise RuntimeError("The Antigravity smoke requires the Linux unshare command and user, mount, and network namespaces.")
    result = subprocess.run([unshare, "-Urnm", "true"], stdin=subprocess.DEVNULL,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=30)
    if result.returncode != 0:
        raise RuntimeError("The Antigravity smoke requires unprivileged user, mount, and network namespaces "
                           "(unshare -Urnm); this environment refuses them: " + result.stderr.strip()[-2000:])


def enter_namespace(spec):
    require(os.geteuid() == 0, "The isolated fixture must enter its user namespace as root.")
    ip, mount = tool("ip"), tool("mount")
    invoke(ip, "link", "set", "lo", "up", note="The isolated fixture could not raise its loopback interface")
    invoke(ip, "addr", "add", HOSTS_ADDRESS + "/32", "dev", "lo",
           note="The isolated fixture could not add its loopback address")
    invoke(mount, "--make-rprivate", "/", note="The isolated fixture could not privatize its mount propagation")
    invoke(mount, "--bind", spec["hosts"], "/etc/hosts",
           note="The isolated fixture could not bind its hosts file over /etc/hosts")
    invoke(mount, "--bind", spec["ca"], spec["caTarget"],
           note="The isolated fixture could not bind its CA bundle over the system default")
    require(Path("/proc/self/ns/net").readlink() != spec["parentNet"], "The isolated fixture shares the host network namespace.")
    require(Path("/proc/self/ns/mnt").readlink() != spec["parentMount"], "The isolated fixture shares the host mount namespace.")
    require(Path("/etc/hosts").read_text().startswith("# zproxy AG fixture"), "The isolated hosts mapping is missing.")
    require(Path(spec["caTarget"]).read_bytes() == Path(spec["ca"]).read_bytes(), "The isolated CA bundle is missing.")
    default = invoke(ip, "route", "show", "default", note="The isolated fixture could not read its routes").stdout.strip()
    require(default == "", "The isolated network namespace still has a default route.")
    resolved = {address[4][0] for address in socket.getaddrinfo("daily-cloudcode-pa.googleapis.com", 443,
                                                                family=socket.AF_INET, type=socket.SOCK_STREAM)}
    require(resolved == {HOSTS_ADDRESS}, "The official hostname does not resolve to the isolated fixture.")


def isolated(binary, omp_dir, timeout):
    require_namespaces()
    with tempfile.TemporaryDirectory(prefix="zproxy-ag-") as temporary:
        directory = Path(temporary)
        directory.chmod(0o700)
        cert, key, bundle = generate_tls(directory)
        hosts = write_hosts(directory)
        target = ca_target()
        spec = {
            "binary": str(binary), "ompDir": str(omp_dir), "timeout": timeout,
            "cert": str(cert), "key": str(key), "ca": str(bundle), "caTarget": target, "hosts": str(hosts),
            "parentNet": os.readlink("/proc/self/ns/net"),
            "parentMount": os.readlink("/proc/self/ns/mnt"),
        }
        path = directory / "spec.json"
        path.write_text(json.dumps(spec))
        path.chmod(0o600)
        unshare = shutil.which("unshare")
        process = subprocess.Popen([unshare, "-Urnm", sys.executable, str(Path(__file__).resolve()), "--inside", str(path)],
                                   stdin=subprocess.DEVNULL)
        try:
            code = process.wait(timeout=timeout + 120)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=10)
            raise RuntimeError("The isolated Antigravity fixture did not finish in time.")
    require(code == 0, f"The isolated Antigravity fixture failed with status {code}.")


def run(binary, omp_dir, timeout, antigravity=False, tls=None):
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

    def catalog():
        return {
            "models": {"models/" + OFFICIAL_MODEL: {
                "model": OFFICIAL_MODEL_ENUM, "displayName": "Gemini 3.8 Flash", "apiProvider": "google",
                "modelProvider": "MODEL_PROVIDER_GOOGLE", "maxOutputTokens": 65536, "maxTokens": 8192,
                "thinkingLevel": 1, "supportsThinking": True,
                "quotaInfo": {"remainingFraction": 1.0, "resetTime": "2099-01-01T00:00:00Z"}}},
            "defaultAgentModelId": "models/" + OFFICIAL_MODEL,
            "agentModelSorts": [{"displayName": "Recommended",
                                 "groups": [{"modelIds": ["models/" + OFFICIAL_MODEL]}]}],
        }

    official_replies = {
        "/v1internal:loadCodeAssist": {"currentTier": {"id": "free-tier", "name": "Free"},
                                       "allowedTiers": [{"id": "free-tier", "name": "Free"}],
                                       "cloudaicompanionProject": "smoke-project"},
        "/v1internal:fetchAvailableModels": catalog(),
        "/v1internal:fetchUserInfo": {"userSettings": {"telemetryEnabled": False}, "regionCode": "US"},
        "/v1internal:listExperiments": {"experimentIds": [], "flags": []},
        "/v1internal:retrieveUserQuotaSummary": {"groups": [], "description": ""},
        "/v1internal:fetchAdminControls": {},
        "/v1internal:setUserSettings": {},
        "/v1internal:writeTrajectoryAcls": {},
        "/v1internal:onboardUser": {},
        "/v1internal/cascadeNuxes": {},
        "/v1alpha:fetchConfig": {"experimentConfig": {"enabledExperimentIds": [], "experimentFlags": []}},
    }

    class Origin(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_):
            pass

        def received(self):
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
            return bytes(result)

        def body(self):
            return json.loads(self.received())

        def respond(self, status, value):
            data = json.dumps(value, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            self.wfile.flush()

        def chunk(self, data):
            self.wfile.write(f"{len(data):X}\r\n".encode() + data + b"\r\n")
            self.wfile.flush()
            with raw_lock:
                raw_bytes[0] += len(data)

        def official_headers(self, bearer=True):
            host = self.headers.get("Host", "")
            require(host in OFFICIAL_DOMAINS, "The official Go client did not use a fixed official host.")
            require("gzip" in (self.headers.get("Accept-Encoding") or ""), "The official Go client did not advertise its standard encoding.")
            for secret in (password, user_uuid, caller_key):
                require(secret not in str(self.headers), "A caller credential reached the upstream.")
            if bearer:
                require(self.headers.get("Authorization") == "Bearer " + provider_key, "The official client did not use the owned access token.")
            return host

        def do_GET(self):
            try:
                if not self.server.official:
                    self.respond(404, {})
                    return
                host = self.official_headers(bearer=False)
                target = urllib.parse.urlsplit(self.path)
                if target.path == "/oauth2/v2/userinfo":
                    require(host == "www.googleapis.com", "The official userinfo host changed.")
                    self.official_headers(bearer=True)
                    self.respond(200, {"id": "fixture", "email": "fixture@fixture.invalid", "verified_email": True,
                                       "name": "Fixture", "given_name": "Fixture", "family_name": "User"})
                elif target.path == "/oauth2/v3/tokeninfo":
                    require(host == "www.googleapis.com", "The official tokeninfo host changed.")
                    query = urllib.parse.parse_qs(target.query)
                    require(query.get("access_token") == [provider_key], "The official client did not check the owned token.")
                    self.respond(200, {"expires_in": "3600"})
                elif target.path == "/log":
                    require(host == "play.googleapis.com", "The official clearcut host changed.")
                    self.official_headers(bearer=True)
                    self.received()
                    self.respond(200, {})
                elif target.path.startswith("/v1alpha:") or target.path.startswith("/v1alpha/"):
                    require(host == "aicode.googleapis.com", "The official aicode host changed.")
                    require(self.headers.get("User-Agent", "").startswith("antigravity/hub/"), "The official client identity changed.")
                    self.official_headers(bearer=True)
                    self.respond(200, official_replies.get(target.path, {}))
                elif target.path == "/v1internal/cascadeNuxes":
                    require(host == "daily-cloudcode-pa.googleapis.com", "The official daily host changed.")
                    require(self.headers.get("User-Agent", "").startswith("antigravity/hub/"), "The official client identity changed.")
                    self.official_headers(bearer=True)
                    self.respond(200, {})
                else:
                    self.respond(404, {})
            except Exception as error:
                failures.put(str(error))
                self.close_connection = True

        def do_POST(self):
            try:
                if self.server.official:
                    self.official_post()
                else:
                    self.plain_post()
            except Exception as error:
                failures.put(str(error))
                self.close_connection = True

        def plain_post(self):
            require(self.path == "/v1/chat/completions", "The selected upstream route changed.")
            require(self.headers.get("Authorization") == "Bearer " + provider_key, "OMP did not use the server-only credential.")
            require(self.headers.get("Accept-Encoding") == "identity", "OMP did not select uncompressed raw response bytes.")
            for secret in (password, user_uuid, caller_key):
                require(secret not in str(self.headers), "A caller credential reached the upstream.")
            body = self.body()
            require(body.get("model") == "model", "The remote model alias was not resolved.")
            require(body.get("stream") is True, "The remote OMP adapter did not request the raw stream.")
            contents = body.get("messages")
            legacy = "legacy-smoke" in json.dumps(contents)
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
                self.chunk(frame({"choices": [{"index": 0, "delta": {"content": "legacy-result"}, "finish_reason": None}]}))
            else:
                self.chunk(first)
                require(release.wait(remaining(30)), "Parsed reasoning did not reach the caller before upstream EOF.")
                self.chunk(visible)
                require(finish_stream.wait(remaining(30)), "Parsed visible text did not reach the caller before upstream EOF.")
            self.chunk(terminal)
            self.wfile.write(b"0\r\n\r\n")
            self.wfile.flush()
            if not legacy:
                origin_finished.set()

        def official_post(self):
            host = self.official_headers(bearer=True)
            require(self.connection.cipher() is not None, "The official client did not complete a normal TLS handshake.")
            target = urllib.parse.urlsplit(self.path)
            if target.path == "/log":
                require(host == "play.googleapis.com", "The official clearcut host changed.")
                self.received()
                self.respond(200, {})
                return
            if target.path == "/v1internal:streamGenerateContent":
                require(host == "daily-cloudcode-pa.googleapis.com", "The official generation host changed.")
                require(self.connection.version().startswith("TLS"), "The official hop is not TLS.")
                require(self.headers.get("Content-Type", "").startswith("application/json"), "The official hop did not send JSON.")
                require(self.headers.get("User-Agent", "").startswith("antigravity/hub/"), "The official client identity changed.")
                body = self.body()
                require(body.get("requestType") == "agent", "A non-agent official request reached the generation route.")
                require(body.get("project") == "smoke-project", "The selected account project was lost.")
                require(body.get("model") == OFFICIAL_MODEL, "The remote AG model alias and effort tier were not resolved.")
                require("messages" not in body and "_zproxy_ag" not in json.dumps(body), "A private request format reached the upstream.")
                require(str(body.get("requestId", "")).startswith("agent/"), "The official request id shape changed.")
                contents = body.get("request", {}).get("contents", [])
                legacy = "legacy-smoke" in json.dumps(contents)
                followup = "followup-smoke" in json.dumps(contents)
                if followup:
                    require(any(part.get("thoughtSignature") == signature for item in contents
                                if item.get("role") == "model" for part in item.get("parts", [])),
                            "The next turn did not restore its matching local thought signature.")
                self.send_response(200)
                self.send_header("Content-Type", "text/event-stream")
                self.send_header("Transfer-Encoding", "chunked")
                self.end_headers()
                if legacy:
                    with raw_lock:
                        legacy_started[0] += 1
                        if legacy_started[0] == legacy_count:
                            legacy_ready.set()
                    require(legacy_ready.wait(remaining(30)), "A provider or local codec concurrency cap blocked parallel requests.")
                    self.chunk(google([{"text": "legacy-result"}], "STOP"))
                elif followup:
                    self.chunk(google([{"text": "followup-result"}], "STOP"))
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
                return
            if target.path.startswith("/v1internal"):
                require(host in ("daily-cloudcode-pa.googleapis.com", "cloudcode-pa.googleapis.com"),
                        "The official cold start host changed.")
                require(self.headers.get("User-Agent", "").startswith("antigravity/hub/"), "The official client identity changed.")
                body = self.body()
                require(isinstance(body, dict), "The official cold start sent a malformed body.")
                self.respond(200, official_replies.get(target.path, {}))
                return
            self.respond(404, {})

    if antigravity:
        require(tls is not None, "The Antigravity fixture requires its generated TLS certificate.")
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.minimum_version = ssl.TLSVersion.TLSv1_2
        context.load_cert_chain(str(tls[0]), str(tls[1]))
        origin = http.server.ThreadingHTTPServer((HOSTS_ADDRESS, 443), Origin)
        origin.socket = context.wrap_socket(origin.socket, server_side=True)
    else:
        origin = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Origin)
    origin.official = antigravity
    origin.daemon_threads = True
    origin.request_queue_size = 64
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
        if antigravity:
            models.write_text(json.dumps({"providers": {"google-antigravity": {
                "baseUrl": OFFICIAL_BASE,
                "api": "google-gemini-cli",
                "apiKey": json.dumps({"token": provider_key, "projectId": "smoke-project",
                                      "email": "fixture@fixture.invalid",
                                      "expiresAt": int(time.time() * 1000) + 3600000}),
                "models": [{"id": "gemini-3.8-flash", "name": "Fixture", "reasoning": True, "input": ["text"],
                            "contextWindow": 8192, "maxTokens": 1024,
                            "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}]}}}))
            provider, model_id = "google-antigravity", "gemini-3.8-flash"
        else:
            models.write_text(json.dumps({"providers": {"fixture": {
                "baseUrl": f"http://127.0.0.1:{origin.server_port}/v1",
                "api": "openai-completions", "apiKey": provider_key,
                "models": [{"id": "model", "name": "Fixture", "reasoning": True, "input": ["text"], "contextWindow": 8192,
                            "maxTokens": 1024, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0}}]}}}))
            provider, model_id = "fixture", "model"
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
            # The routing summary crosses the private socket with a bodyless read.
            # This is the only place that proves the F# head framing and the Bun
            # route agree; without the shims configuration the endpoint must say
            # so instead of answering a zero-filled snapshot.
            admin_cookie = "zproxy-admin=" + cookies["zproxy-admin"].value
            phase = "reading the routing summary over the private socket"
            status, routing_headers, routing_body = web("GET", "/admin/api/routing", None, admin_cookie)
            require(status == 200, f"The routing summary returned {status}.")
            require(routing_headers.get("Content-Type", "").startswith("application/json"),
                    "The routing summary is not JSON.")
            routing = json.loads(routing_body)
            require(isinstance(routing.get("available"), bool),
                    "The routing summary does not state its availability.")
            require(set(routing) <= {"schemaVersion", "available", "reason", "detail", "generatedAt",
                                     "buildVersion", "snapshotId", "epochSince", "store", "period",
                                     "catalog", "metrics", "aggregate"},
                    f"The routing summary grew a key outside the documented shape: {sorted(routing)}")
            # The projection must never carry an account identity, a model name,
            # or a host. Assert on the raw text, not on a selected field.
            for forbidden in ("unitRef", "u_", "accountId", "@", "host", "pid"):
                require(forbidden not in routing_body.decode(),
                        f"The routing summary exposed {forbidden!r}.")
            phase = "serving the authenticated routing page"
            status, page_headers, page_body = web("GET", "/admin/reports", None, admin_cookie)
            require(status == 200 and b'data-page="routing"' in page_body,
                    "The routing page did not load its own shell.")
            require("script-src 'self'" in page_headers.get("Content-Security-Policy", ""),
                    "The routing page lost its content security policy.")
            status, _, anonymous_body = web("GET", "/admin/api/routing")
            require(status == 401, "The routing summary answered without a session.")
            require(b"routing" not in anonymous_body, "The routing summary leaked to an unauthenticated caller.")

            status, _, data = web("POST", "/admin/api/users", {"nickname": nickname}, admin_cookie)
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
                if response.status != 200:
                    detail = response.read(4096).decode(errors="replace")
                    for secret in (password, provider_key, caller_key, user_uuid):
                        if secret:
                            detail = detail.replace(secret, "[redacted]")
                    raise RuntimeError(f"The streamed completion returned {response.status}: {detail}")
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
                        if probe.status != 200:
                            detail = probe.read(4096).decode(errors="replace")
                            for secret in (password, provider_key, caller_key, user_uuid):
                                if secret:
                                    detail = detail.replace(secret, "[redacted]")
                            raise RuntimeError(f"The concurrent legacy completion failed: HTTP {probe.status}, {detail}")
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
            print("Origin legacy requests started:", legacy_started[0], "of", legacy_count)
            while not failures.empty():
                print("Origin:", failures.get_nowait())
            for log in logs:
                content = log.read_text(errors="replace")[-8000:]
                for secret in (password, provider_key, caller_key, user_uuid):
                    if secret:
                        content = content.replace(secret, "[redacted]")
                print(log.name + ":\n" + content)
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


def inside(spec_path):
    spec = json.loads(spec_path.read_text())
    enter_namespace(spec)
    run(Path(spec["binary"]), Path(spec["ompDir"]), spec["timeout"], True, (spec["cert"], spec["key"]))


def main():
    if len(sys.argv) == 3 and sys.argv[1] == "--inside":
        inside(Path(sys.argv[2]))
        return
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--binary", required=True, type=Path)
    parser.add_argument("--omp-dir", type=Path, default=Path(__file__).resolve().parents[1] / "plugins" / "omp")
    parser.add_argument("--timeout", type=float, default=120)
    parser.add_argument("--antigravity2api", action="store_true",
                        help="Use the pinned AG Go codec against an owned TLS fixture in isolated user, mount, and network namespaces.")
    args = parser.parse_args()
    binary, omp_dir = args.binary.resolve(), args.omp_dir.resolve()
    require(binary.is_file() and os.access(binary, os.X_OK), "--binary must be an executable file.")
    require((omp_dir / "local.mjs").is_file() and (omp_dir / "remote.mjs").is_file(), "--omp-dir must contain both workers.")
    require(10 <= args.timeout <= 600, "--timeout must be between 10 and 600 seconds.")
    if args.antigravity2api:
        require((omp_dir / "bin" / "zproxy-ag").is_file(), "The AG2API smoke requires the bundled Go codec.")
        isolated(binary, omp_dir, args.timeout)
    else:
        run(binary, omp_dir, args.timeout)


if __name__ == "__main__":
    main()
