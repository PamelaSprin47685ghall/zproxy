import { expect, test } from "bun:test";
import { createConnection } from "node:net";
import { ipcResponse } from "./ipc-response.mjs";
import { chunkedResponse } from "./remote.mjs";

function exchange(port, path, body) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const parts = [];
    let length = 0;
    const timer = setTimeout(() => socket.destroy(new Error("The private response did not finish.")), 5000);
    socket.on("error", reject);
    socket.on("close", () => clearTimeout(timer));
    socket.on("data", bytes => {
      length += bytes.length;
      if (length > 65536) socket.destroy(new Error("The private fixture response exceeds its limit."));
      else parts.push(bytes);
    });
    socket.on("end", () => resolve(Buffer.concat(parts).toString()));
    socket.on("connect", () => {
      socket.write(`POST ${path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`);
      socket.write(`${Buffer.byteLength(body).toString(16)}\r\n${body}\r\n0\r\n\r\n`);
    });
  });
}

function readChunks(wire) {
  const split = wire.indexOf("\r\n\r\n");
  const head = wire.slice(0, split);
  expect(head.toLowerCase().split("\r\n")).toContain("transfer-encoding: chunked");
  expect(head.toLowerCase()).not.toContain("content-length:");
  let remaining = wire.slice(split + 4);
  let body = "";
  while (true) {
    const line = remaining.indexOf("\r\n");
    expect(line).toBeGreaterThan(0);
    const size = Number.parseInt(remaining.slice(0, line), 16);
    expect(Number.isSafeInteger(size)).toBe(true);
    remaining = remaining.slice(line + 2);
    if (size === 0) {
      expect(remaining).toBe("\r\n");
      return { head, body };
    }
    body += remaining.slice(0, size);
    expect(remaining.slice(size, size + 2)).toBe("\r\n");
    remaining = remaining.slice(size + 2);
  }
}

test("private short JSON responses stay chunked through passthrough, augmentation, and errors", async () => {
  const original = '{"model":"fixture","prompt":"short","stream":false}';
  const responses = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const path = new URL(request.url).pathname;
    let response;
    if (path === "/passthrough") response = new Response(request.body, { headers: { "content-type": "application/json" } });
    else {
      const value = await request.json();
      if (path === "/augment") response = Response.json({ ...value, _zproxy_ag: { version: 1, messages: [] } });
      else response = Response.json({ error: "fixture rejection" }, { status: 400,
        headers: { "retry-after": "1", "x-private-secret": "must-stay-private" } });
    }
    responses.push(response);
    return path === "/remote-error" ? chunkedResponse(response) : ipcResponse(response);
  } });
  try {
    const paths = ["/passthrough", ...Array(6).fill("/augment"), "/local-error", "/remote-error"];
    const replies = await Promise.all(paths.map(path => exchange(server.port, path, original)));
    for (let index = 0; index < replies.length; index++) {
      const { head, body } = readChunks(replies[index]);
      const path = paths[index];
      expect(head).toStartWith(`HTTP/1.1 ${path.endsWith("error") ? 400 : 200} `);
      if (path === "/passthrough") expect(body).toBe(original);
      else if (path === "/augment") expect(JSON.parse(body)).toEqual({ ...JSON.parse(original), _zproxy_ag: { version: 1, messages: [] } });
      else expect(JSON.parse(body)).toEqual({ error: "fixture rejection" });
      if (path === "/remote-error") {
        expect(head.toLowerCase()).toContain("retry-after: 1");
        expect(head).not.toContain("must-stay-private");
      }
    }
    expect(responses.every(response => !response.body.locked)).toBe(true);
  } finally { server.stop(true); }
}, 10000);

test("disconnecting the private peer cancels and unlocks the response source", async () => {
  const cancelled = Promise.withResolvers();
  const source = new ReadableStream({
    start(output) { output.enqueue(Buffer.from("fixture-active")); },
    cancel() { cancelled.resolve(); },
  }, { highWaterMark: 0 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0,
    fetch: () => ipcResponse(new Response(source)),
  });
  const socket = createConnection({ host: "127.0.0.1", port: server.port });
  const arrived = Promise.withResolvers();
  let wire = "";
  socket.on("error", error => arrived.reject(error));
  socket.on("data", bytes => {
    wire += bytes;
    if (wire.includes("fixture-active")) { socket.destroy(); arrived.resolve(); }
  });
  socket.on("connect", () => socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n"));
  try {
    await arrived.promise;
    await cancelled.promise;
    await new Promise(resolve => setImmediate(resolve));
    expect(source.locked).toBe(false);
  } finally { socket.destroy(); server.stop(true); }
}, 2000);
