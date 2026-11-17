// Own a private Go codec process. It never receives an upstream credential.
import { request as httpRequest } from "node:http";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// The worker bounds one caller request. An official envelope repeats labels,
// tools, and signatures on top of that request, so the worker applies its own
// fixed overhead there, and its prepare reply wraps the envelope in one object.
const MAX_JSON = 64 * 1024 * 1024;
const MAX_OFFICIAL_ENVELOPE = MAX_JSON + (4 * 1024 * 1024);
const MAX_OFFICIAL_JSON = MAX_OFFICIAL_ENVELOPE + 1024;
const encoder = new TextEncoder();

/** Read and write the private HTTP exchange at the same time, with backpressure. */
export function privateRequest(socket, path, { body, signal, headers = {}, method = "POST" } = {}) {
  return new Promise((resolve, reject) => {
    const source = body?.getReader();
    let incoming;
    let output;
    let settled = false;
    let closed = false;
    let inputReleased = false;
    let pendingWrite;
    const releaseInput = () => {
      if (inputReleased) return;
      inputReleased = true;
      void source?.cancel().catch(() => {});
      try { source?.releaseLock(); } catch {}
    };
    const request = httpRequest({ socketPath: socket, path, method, agent: false, headers: {
      "content-type": "application/octet-stream", "connection": "close", ...headers,
    } });
    const cleanup = () => {
      if (closed) return;
      closed = true;
      signal?.removeEventListener("abort", onAbort);
      pendingWrite?.();
      releaseInput();
      incoming?.destroy();
      request.destroy();
    };
    const onAbort = () => request.destroy(signal.reason instanceof Error ? signal.reason : new Error("The codec call was cancelled."));
    const fail = error => {
      if (closed) return;
      if (!settled) { settled = true; reject(error); }
      else if (!closed) output?.error(error);
      cleanup();
    };
    request.once("error", fail);
    request.once("response", response => {
      if (closed) { response.destroy(); return; }
      incoming = response;
      response.once("error", fail);
      const iterator = response[Symbol.asyncIterator]();
      const responseHeaders = new Headers();
      // The refusal header is the worker's private classification of one
      // official rejection. It carries a single fixed value and no upstream
      // text, so it reaches the adapter and nothing else does.
      for (const key of ["content-type", "cache-control", "retry-after", "x-zproxy-refusal"]) {
        const value = response.headers[key];
        if (typeof value === "string") responseHeaders.set(key, value);
      }
      settled = true;
      resolve(new Response(new ReadableStream({
        start(target) { output = target; },
        async pull(target) {
          try {
            const item = await iterator.next();
            if (closed) return;
            if (item.done) { target.close(); cleanup(); }
            else target.enqueue(new Uint8Array(item.value));
          } catch (error) { if (!closed) { target.error(error); cleanup(); } }
        },
        cancel() { cleanup(); },
      }, { highWaterMark: 0 }), { status: response.statusCode, headers: responseHeaders }));
    });
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    request.flushHeaders();
    void (async () => {
      try {
        while (source && !closed) {
          const next = await source.read();
          if (next.done || closed) break;
          if (!request.write(next.value)) await new Promise(done => {
            const finish = () => { request.off("drain", finish); pendingWrite = undefined; done(); };
            pendingWrite = finish;
            request.once("drain", finish);
            if (closed) finish();
          });
        }
        if (!closed) request.end();
      } catch (error) { request.destroy(error); }
      finally { releaseInput(); }
    })();
  });
}

export async function readJsonBody(response, limit = MAX_JSON) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The codec returned no JSON body.");
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new Error("The codec JSON body exceeds its limit.");
      chunks.push(next.value);
    }
    if (!response.ok) throw Object.assign(new Error("The Antigravity codec rejected the request."),
      { status: response.status === 400 ? 400 : 502, publicMessage: "The Antigravity codec rejected the request." });
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

/**
 * Reduce one private official error reply to its status.
 *
 * The worker answers an official route with a status, one fixed sentence, and
 * nothing else, and the sentence describes the private exchange rather than the
 * upstream. Only the status is taken here: the caller-facing sentence belongs
 * to the adapter that knows what the status means for this request, so no
 * worker body text is parsed, buffered, or repeated.
 */
async function officialFailure(response) {
  const status = response.status >= 400 && response.status <= 599 ? response.status : 502;
  try { await response.body?.cancel(); } catch {}
  return Object.assign(new Error("The Antigravity codec rejected the request."), { status });
}

/**
 * Read the private prepare reply.
 *
 * The worker answers with exactly one object that holds the envelope and
 * nothing else. The bound is the envelope bound the worker itself applies, so
 * a reply larger than any envelope it could build is refused instead of being
 * buffered, and any key other than `body` is refused rather than ignored. The
 * envelope's own shape is the adapter's check, because only it knows the
 * project and model this request was prepared for.
 */
async function readOfficialEnvelope(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("The codec returned no official envelope.");
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      length += next.value.byteLength;
      if (length > limit) throw new Error("The official codec reply exceeds its limit.");
      chunks.push(next.value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The official codec reply is not an object.");
    const keys = Object.keys(value);
    if (keys.length !== 1 || keys[0] !== "body") throw new Error("The official codec reply has unexpected fields.");
    if (!value.body || typeof value.body !== "object" || Array.isArray(value.body)) throw new Error("The official codec reply carries no envelope.");
    return value;
  } catch (error) { await reader.cancel(error).catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
}

function joinedBody(prefix, body) {
  const reader = body.getReader();
  let initial = true;
  let closed = false;
  return new ReadableStream({
    async pull(target) {
      if (closed) return;
      if (initial) { initial = false; target.enqueue(prefix); return; }
      try {
        const item = await reader.read();
        if (closed) return;
        if (item.done) { closed = true; reader.releaseLock(); target.close(); }
        else target.enqueue(item.value);
      } catch (error) { if (!closed) { closed = true; reader.releaseLock(); target.error(error); } }
    },
    async cancel(reason) {
      if (closed) return;
      closed = true;
      try { await reader.cancel(reason); } finally { reader.releaseLock(); }
    },
  }, { highWaterMark: 0 });
}

export function createAgWorker({ binary = fileURLToPath(new URL("./bin/zproxy-ag", import.meta.url)), onExit, stateDir } = {}) {
  let starting;
  let folder;
  let child;
  let socket;
  let stopping = false;
  let closing;
  let stoppedChild;
  let drains = [];
  // The child writes only bounded diagnostic lines to stderr: a status and an
  // upstream ErrorInfo reason, never a body, a project, a handle, or a token.
  // Forwarding them keeps that evidence on the service log, and a child that
  // writes nothing costs nothing.
  const drain = async stream => { try { for await (const _ of stream) {} } catch {} };
  const relay = async stream => {
    const decoder = new TextDecoder();
    try {
      for await (const chunk of stream) {
        const text = decoder.decode(chunk, { stream: true });
        if (text) process.stderr.write(text);
      }
    } catch {}
  };
  const stopChild = () => {
    if (!child) return Promise.resolve();
    return stoppedChild ??= (async () => {
      if (child.exitCode !== null) return;
      const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
      try { child.kill("SIGTERM"); await child.exited; }
      finally { clearTimeout(timer); }
    })();
  };
  const start = () => starting ??= (async () => {
    try {
      if (stopping) throw new Error("The Antigravity codec is closed.");
      folder = await mkdtemp(join(tmpdir(), "zpa-"));
      await chmod(folder, 0o700);
      if (stopping) throw new Error("The Antigravity codec is closed.");
      socket = join(folder, "codec.sock");
      const env = Object.fromEntries(["PATH", "LANG", "LC_ALL", "TZ", "LD_LIBRARY_PATH"]
        .filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
      env.TMPDIR = folder;
      env.XDG_CACHE_HOME = folder;
      // Only the remote worker owns official accounts and their Hub/session
      // state, so only it receives --state-dir. A local worker starts with the
      // socket alone, where the official routes do not exist.
      const args = [binary, "--socket", socket, ...(stateDir === undefined ? [] : ["--state-dir", stateDir])];
      child = Bun.spawn(args, { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
      drains.push(relay(child.stderr));
      void child.exited.then(() => { if (!stopping) onExit?.(); });
      const reader = child.stdout.getReader();
      const deadline = setTimeout(() => child.kill("SIGKILL"), 30000);
      let text = "";
      try {
        while (!text.includes("\n")) {
          const item = await reader.read();
          if (item.done) throw new Error("The Antigravity codec did not start.");
          text += new TextDecoder().decode(item.value);
          if (text.length > 1024) throw new Error("Invalid Antigravity codec startup response.");
        }
        if (text.trim() !== "READY") throw new Error("The Antigravity codec did not become ready.");
      } finally { clearTimeout(deadline); reader.releaseLock(); }
      drains.push(drain(child.stdout));
      return socket;
    } catch (error) {
      stopping = true;
      await stopChild();
      await Promise.allSettled(drains);
      if (folder) await rm(folder, { recursive: true, force: true });
      throw error;
    }
  })();
  return {
    get started() { return starting !== undefined; },
    async request(path, options) {
      const address = await start();
      if (stopping || child.exitCode !== null) throw new Error("The Antigravity codec is not running.");
      return privateRequest(address, path, options);
    },
    async device(email, { signal } = {}) {
      const response = await this.request("/device", { signal, body: new Response(JSON.stringify({ version: 1, email })).body,
        headers: { "content-type": "application/json" } });
      return (await readJsonBody(response, 4096)).device;
    },
    async officialPrepare(value, { signal } = {}) {
      const response = await this.request("/official-prepare", { signal, body: new Response(JSON.stringify(value)).body,
        headers: { "content-type": "application/json" } });
      if (!response.ok) throw await officialFailure(response);
      return readOfficialEnvelope(response, MAX_OFFICIAL_JSON);
    },
    // The raw upstream stream travels back untouched, so a rejection keeps the
    // status the worker reported for the adapter to classify.
    async officialSend(value, { signal } = {}) {
      return this.request("/official-send", { signal, body: new Response(JSON.stringify(value)).body,
        headers: { "content-type": "application/json" } });
    },
    async augment(body, signal) {
      return this.request("/augment", { body, signal, headers: { "content-type": "application/json" } });
    },
    async decode(value, reasoningOrder) {
      const original = encoder.encode(JSON.stringify(value.request));
      const envelope = encoder.encode(JSON.stringify({ version: 1, path: value.path, requestBytes: original.byteLength,
        metadata: value.metadata, status: value.status, headers: value.headers }));
      if (envelope.byteLength > 65536 || original.byteLength > MAX_JSON) throw new Error("The Antigravity decode context exceeds its limit.");
      const prefix = new Uint8Array(4 + envelope.byteLength + original.byteLength);
      new DataView(prefix.buffer).setUint32(0, envelope.byteLength);
      prefix.set(envelope, 4);
      prefix.set(original, 4 + envelope.byteLength);
      const body = joinedBody(prefix, value.body);
      try {
        return await this.request("/decode", { signal: value.signal, body,
          headers: reasoningOrder ? { "x-zproxy-reasoning-order": "1" } : {} });
      } catch (error) { await body.cancel(error).catch(() => {}); throw error; }
    },
    close() {
      if (closing) return closing;
      stopping = true;
      return closing = (async () => {
        try {
          await stopChild();
          if (starting) await starting.catch(() => {});
          await Promise.allSettled(drains);
        } finally {
          if (folder) await rm(folder, { recursive: true, force: true });
        }
      })();
    },
  };
}
