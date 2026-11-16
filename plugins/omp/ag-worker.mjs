// Own a private Go codec process. It never receives an upstream credential.
import { request as httpRequest } from "node:http";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_JSON = 64 * 1024 * 1024;
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
    const request = httpRequest({ socketPath: socket, path, method, headers: {
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
      for (const key of ["content-type", "cache-control", "retry-after"]) {
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

export function createAgWorker({ binary = fileURLToPath(new URL("./bin/zproxy-ag", import.meta.url)), onExit } = {}) {
  let starting;
  let folder;
  let child;
  let socket;
  let stopping = false;
  let closing;
  let stoppedChild;
  let drains = [];
  const drain = async stream => { try { for await (const _ of stream) {} } catch {} };
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
      child = Bun.spawn([binary, "--socket", socket], { stdin: "ignore", stdout: "pipe", stderr: "pipe", env });
      drains.push(drain(child.stderr));
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
    async prepare(value, { signal } = {}) {
      const response = await this.request("/prepare", { signal, body: new Response(JSON.stringify(value)).body,
        headers: { "content-type": "application/json" } });
      return readJsonBody(response);
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
        } finally { if (folder) await rm(folder, { recursive: true, force: true }); }
      })();
    },
  };
}
