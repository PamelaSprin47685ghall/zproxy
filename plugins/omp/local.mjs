#!/usr/bin/env bun
// The local worker has no account store, upstream URL, or network fetch path.
import { chmod, lstat, unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { decodeUpstream, errorResponse, finishBody, jsonResponse } from "./local-codec.mjs";

const MAX_ENVELOPE = 65536;
const MAX_REQUEST = 64 * 1024 * 1024;
const MAX_ACTIVE = 4;
const utf8 = new TextDecoder("utf-8", { fatal: true });

class InputReader {
  constructor(body) {
    if (!body) throw new Error("The decoder request has no body.");
    this.reader = body.getReader();
    this.pending = new Uint8Array();
  }

  async take(size) {
    const result = new Uint8Array(size);
    let offset = 0;
    while (offset < size) {
      if (this.pending.length === 0) {
        const next = await this.reader.read();
        if (next.done) throw new Error("The decoder request ended before its envelope.");
        this.pending = next.value;
      }
      const count = Math.min(size - offset, this.pending.length);
      result.set(this.pending.subarray(0, count), offset);
      offset += count;
      this.pending = this.pending.subarray(count);
    }
    return result;
  }

  remainder() {
    return new ReadableStream({
      pull: async output => {
        if (this.pending.length !== 0) {
          output.enqueue(this.pending);
          this.pending = new Uint8Array();
          return;
        }
        const next = await this.reader.read();
        if (next.done) output.close();
        else output.enqueue(next.value);
      },
      cancel: reason => this.reader.cancel(reason),
    });
  }

  cancel(reason) { return this.reader.cancel(reason).catch(() => {}); }
}

export async function readDecodeRequest(request) {
  const input = new InputReader(request.body);
  try {
    const lengthBytes = await input.take(4);
    const length = new DataView(lengthBytes.buffer, lengthBytes.byteOffset, 4).getUint32(0);
    if (length === 0 || length > MAX_ENVELOPE) throw new Error("Invalid decoder envelope size.");
    const envelope = JSON.parse(utf8.decode(await input.take(length)));
    if (envelope.version !== 1 || !Number.isInteger(envelope.requestBytes) || envelope.requestBytes <= 0 || envelope.requestBytes > MAX_REQUEST) {
      throw new Error("Invalid decoder request length or version.");
    }
    if (envelope.path !== "/v1/chat/completions" && envelope.path !== "/v1/completions") throw new Error("Invalid decoder route.");
    if (envelope.metadata?.decoder !== "omp-response" || envelope.metadata?.version !== 1 || typeof envelope.metadata.recipe !== "string") throw new Error("Invalid decoder metadata.");
    if (!Number.isInteger(envelope.status) || envelope.status < 200 || envelope.status >= 300) throw new Error("Invalid upstream status.");
    if (!Array.isArray(envelope.headers) || envelope.headers.length > 32 || envelope.headers.some(pair => !Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== "string" || /[\r\n\0]/u.test(value)))) throw new Error("Invalid upstream headers.");
    const original = JSON.parse(utf8.decode(await input.take(envelope.requestBytes)));
    return { path: envelope.path, request: original, recipe: envelope.metadata.recipe, status: envelope.status, headers: envelope.headers, body: input.remainder(), signal: request.signal };
  } catch (error) {
    await input.cancel(error);
    throw error;
  }
}

export async function startLocal(socket, { reasoningOrder = false, onShutdown } = {}) {
  socket = resolve(socket);
  try {
    const existing = await lstat(socket);
    if (!existing.isSocket()) throw new Error("The local socket path is not a socket.");
    await unlink(socket);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  let active = 0;
  let stopping = false;
  const server = Bun.serve({
    unix: socket, idleTimeout: 0, maxRequestBodySize: MAX_REQUEST + MAX_ENVELOPE + 128 * 1024 * 1024 + 4,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method === "GET" && path === "/health") return jsonResponse({ ok: true, decoder: "omp-response", version: 1 });
      if (request.method === "POST" && path === "/shutdown") {
        stopping = true;
        setTimeout(() => { server.stop(true); onShutdown?.(); }, 10).unref();
        return jsonResponse({ ok: true });
      }
      if (request.method !== "POST" || path !== "/decode") return errorResponse("Unknown local decoder route.", 404);
      if (stopping || active >= MAX_ACTIVE) return errorResponse("The local OMP parser is busy.", 503);
      active++;
      let released = false;
      const release = () => { if (!released) { released = true; active--; } };
      try {
        const decode = await readDecodeRequest(request);
        const response = await decodeUpstream({ ...decode, reasoningOrder });
        return new Response(finishBody(response.body, release), { status: response.status, headers: response.headers });
      } catch (error) {
        release();
        return errorResponse(error instanceof Error ? error.message : "The response could not be decoded.", 400);
      }
    },
  });
  await chmod(socket, 0o600);
  return server;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length < 2 || args[0] !== "--socket" || args.some((value, index) => index > 1 && value !== "--reasoning-order")) {
    throw new Error("Usage: bun local.mjs --socket PATH [--reasoning-order]");
  }
  // Fail closed if a future OMP adapter bypasses the explicit one-response hook.
  globalThis.fetch = async () => { throw new Error("Network fetch is disabled in the local OMP worker."); };
  const server = await startLocal(args[1], { reasoningOrder: args.includes("--reasoning-order"), onShutdown: () => process.exit(0) });
  process.stdout.write("READY\n");
  for (const name of ["SIGTERM", "SIGINT"]) process.on(name, () => { server.stop(true); process.exit(0); });
}
