import { expect, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { createAgWorker, privateRequest, readJsonBody } from "./ag-worker.mjs";

const encoder = new TextEncoder();

function deadline(promise, message, milliseconds = 1000) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), milliseconds);
  })]).finally(() => clearTimeout(timer));
}

test("AG codec request releases an input cancelled before connection", async () => {
  const cancelled = Promise.withResolvers();
  const body = new ReadableStream({ cancel() { cancelled.resolve(); } }, { highWaterMark: 0 });
  const signal = AbortSignal.abort(new Error("fixture cancelled before connection"));
  await expect(privateRequest(join(import.meta.dir, "absent-codec.sock"), "/decode", { body, signal }))
    .rejects.toThrow();
  await deadline(cancelled.promise, "The pre-aborted codec input was not cancelled.");
  expect(body.locked).toBe(false);
});

test("AG codec JSON errors preserve validation status without exposing its body", async () => {
  const error = await readJsonBody(new Response('{"error":"private fixture detail"}', { status: 400 }))
    .catch(value => value);
  expect(error.status).toBe(400);
  expect(error.publicMessage).toBe("The Antigravity codec rejected the request.");
  expect(error.message).not.toContain("private fixture detail");
  await expect(readJsonBody(new Response('{"too":"large"}'), 4)).rejects.toThrow("exceeds its limit");
});

function fakeChild(firstLine) {
  const killed = Promise.withResolvers();
  const exited = Promise.withResolvers();
  let stdout, stderr;
  const child = {
    exitCode: null,
    stdout: new ReadableStream({ start(target) {
      stdout = target;
      if (firstLine) target.enqueue(encoder.encode(firstLine));
    } }),
    stderr: new ReadableStream({ start(target) { stderr = target; } }),
    exited: exited.promise,
    killed: killed.promise,
    kill(signal) {
      if (child.exitCode !== null) return;
      child.exitCode = 0;
      stdout.close();
      stderr.close();
      killed.resolve(signal);
      exited.resolve(0);
    },
  };
  return child;
}

async function fakeWorker(child, run, options = {}) {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = import.meta.dir;
  const spawned = Promise.withResolvers();
  let args;
  let socket;
  const spawn = spyOn(Bun, "spawn").mockImplementation(argv => {
    args = argv;
    socket = argv[2];
    spawned.resolve();
    return child;
  });
  const worker = createAgWorker({ binary: "/fixture/codec", ...options });
  try { await run(worker, spawned.promise, () => socket, () => args); }
  finally {
    child.kill("SIGKILL");
    try { await worker.close(); }
    finally {
      spawn.mockRestore();
      if (previous === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previous;
    }
  }
}

test("AG codec rejects a bad startup line and stops the child", async () => {
  const child = fakeChild("NOT READY\n");
  await fakeWorker(child, async (worker, _spawned, socket) => {
    await expect(worker.request("/health", { method: "GET" })).rejects.toThrow();
    await deadline(child.killed, "The rejected codec process survived startup failure.");
    expect(existsSync(dirname(socket()))).toBe(false);
  });
});

test("AG codec close interrupts a pending startup", async () => {
  const child = fakeChild();
  await fakeWorker(child, async (worker, spawned) => {
    const pending = worker.request("/health", { method: "GET" }).catch(error => error);
    await spawned;
    const closing = worker.close();
    try {
      await deadline(child.killed, "Closing the codec waited for its startup deadline.");
      await closing;
      expect(await pending).toBeInstanceOf(Error);
    } finally {
      child.kill("SIGKILL");
      await closing;
      await pending;
    }
  });
});

function decodeContext(body, signal) {
  return {
    path: "/v1/chat/completions", status: 200, headers: [["Content-Type", "text/event-stream"]],
    request: { model: "friendly", stream: true, messages: [{ role: "user", content: "hello" }] },
    metadata: { decoder: "omp-response", version: 1, modelAlias: "friendly", requestId: "fixture", attempt: 1,
      isStreaming: true, recipe: JSON.stringify({ api: "antigravity2api", provider: "google-antigravity", id: "fixture",
        reasoning: true, input: ["text"], contextWindow: 8192, maxTokens: 1024, compat: { agProvider: "google" } }) },
    body, signal,
  };
}

function pendingInput() {
  let source;
  const cancelled = Promise.withResolvers();
  const body = new ReadableStream({
    start(target) {
      source = target;
      target.enqueue(encoder.encode('data: {"response":{"candidates":[{"content":{"role":"model","parts":[{"text":"Hello"}]}}]}}\n\n'));
    },
    cancel(reason) { cancelled.resolve(reason); },
  }, { highWaterMark: 0 });
  return { body, source, cancelled: cancelled.promise };
}

async function visible(reader) {
  let text = "";
  while (!text.includes('"content":"Hello"')) {
    const item = await deadline(reader.read(), "The codec did not expose text before input EOF.", 5000);
    expect(item.done).toBe(false);
    text += new TextDecoder().decode(item.value);
  }
}

test("private HTTP IPC propagates an input failure after response headers", async () => {
  const worker = createAgWorker();
  const input = pendingInput();
  let reader;
  try {
    const response = await worker.decode(decodeContext(input.body), false);
    expect(response.status).toBe(200);
    reader = response.body.getReader();
    await visible(reader);
    input.source.error(new Error("fixture input failed after headers"));
    await expect(deadline(reader.read(), "The failed codec input left its response pending.")).rejects.toThrow();
    expect(input.body.locked).toBe(false);
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    await worker.close();
  }
});

test("private HTTP IPC returns an early JSON error and stops its input", async () => {
  const worker = createAgWorker();
  const cancelled = Promise.withResolvers();
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, 65537);
  const body = new ReadableStream({
    start(target) { target.enqueue(prefix); },
    cancel() { cancelled.resolve(); },
  }, { highWaterMark: 0 });
  try {
    const response = await worker.request("/decode", { body });
    expect(response.status).toBe(400);
    await expect(deadline(readJsonBody(response), "The early JSON error waited for input EOF.")).rejects.toThrow("rejected");
    await deadline(cancelled.promise, "The rejected codec input was not cancelled.");
    expect(body.locked).toBe(false);
  } finally { await worker.close(); }
});

test("private HTTP IPC response cancellation releases the pending input", async () => {
  const worker = createAgWorker();
  const input = pendingInput();
  let reader;
  try {
    const response = await worker.decode(decodeContext(input.body), false);
    reader = response.body.getReader();
    await visible(reader);
    await reader.cancel("fixture response cancelled");
    await deadline(input.cancelled, "Cancelling the response left its input open.");
    expect(input.body.locked).toBe(false);
  } finally {
    await reader?.cancel().catch(() => {});
    reader?.releaseLock();
    await worker.close();
  }
});

test("only a worker given a state directory passes --state-dir to the codec", async () => {
  for (const [options, expected] of [
    [{}, 3],
    [{ stateDir: "/fixture/state" }, 5],
  ]) {
    const child = fakeChild("READY\n");
    await fakeWorker(child, async (worker, spawned, _socket, args) => {
      // No fixture listens on the private socket, so the exchange fails after
      // the spawn this test observes.
      const pending = worker.request("/health", { method: "GET" }).catch(error => error);
      await spawned;
      expect(args()).toHaveLength(expected);
      if (options.stateDir === undefined) expect(args()).toEqual(["/fixture/codec", "--socket", expect.any(String)]);
      else expect(args()).toEqual(["/fixture/codec", "--socket", expect.any(String), "--state-dir", "/fixture/state"]);
      // Nothing listens on this socket, so stopping the codec must also settle
      // the exchange the worker already started.
      child.kill("SIGKILL");
      expect(await pending).toBeInstanceOf(Error);
    }, options);
  }
});

test("the official prepare reply is read strictly and a rejection keeps its status", async () => {
  const served = [
    { status: 200, body: JSON.stringify({ body: { project: "", model: "m", requestType: "agent", request: { contents: [] } } }) },
    // A reply with an extra field is refused rather than silently accepted.
    { status: 200, body: JSON.stringify({ body: { project: "", model: "m", requestType: "agent", request: {} }, handle: "leak" }) },
    { status: 200, body: JSON.stringify({ envelope: { model: "m" } }) },
    { status: 400, body: JSON.stringify({ error: { type: "invalid_request", message: "invalid official request" } }) },
    { status: 429, body: JSON.stringify({ error: { type: "rate_limit_error", message: "the official account limit is reached" } }) },
    { status: 502, body: JSON.stringify({ error: { type: "upstream_error", message: "x".repeat(9000) } }) },
  ];
  const seen = { prepared: [], sent: [] };
  let server;
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = import.meta.dir;
  let exiting;
  const spawn = spyOn(Bun, "spawn").mockImplementation(args => {
    // The worker allocates its own private socket; the fixture binds that exact
    // path, so the real private HTTP exchange runs end to end.
    server = Bun.serve({
      unix: args[2],
      async fetch(request) {
        const body = await request.json();
        const path = new URL(request.url).pathname;
        if (path === "/official-prepare") {
          seen.prepared.push(body);
          const row = served.shift();
          return new Response(row.body, { status: row.status, headers: { "content-type": "application/json" } });
        }
        if (path === "/official-send") {
          seen.sent.push(body);
          return new Response('data: {"candidates":[]}\n\n', { headers: { "content-type": "text/event-stream" } });
        }
        return new Response(null, { status: 404 });
      },
    });
    return {
      exitCode: null,
      stdout: new ReadableStream({ start(target) { target.enqueue(encoder.encode("READY\n")); target.close(); } }),
      stderr: new ReadableStream({ start(target) { target.close(); } }),
      // The worker stops the child by signal and then awaits its exit, so the
      // fixture must report one.
      exited: new Promise(resolve => { exiting = resolve; }),
      kill() { exiting(0); },
    };
  });
  const worker = createAgWorker({ binary: "/fixture/codec" });
  try {
    const first = await worker.officialPrepare({ version: 1 });
    expect(first.body).toEqual({ project: "", model: "m", requestType: "agent", request: { contents: [] } });
    for (const [count, message] of [[2, "unexpected fields"], [3, "unexpected fields"]]) {
      const error = await worker.officialPrepare({ version: 1 }).catch(value => value);
      expect([seen.prepared.length, error.message]).toEqual([count, expect.stringContaining(message)]);
    }
    // A rejection carries its status and one fixed local sentence; the worker's
    // own text is never parsed, buffered, or repeated.
    for (const status of [400, 429]) {
      const error = await worker.officialPrepare({ version: 1 }).catch(value => value);
      expect([error.status, error.message]).toEqual([status, "The Antigravity codec rejected the request."]);
      expect(error.message).toBe("The Antigravity codec rejected the request.");
    }
    // A large rejection body is not read, so nothing from it can surface.
    const error = await worker.officialPrepare({ version: 1 }).catch(value => value);
    expect(error.status).toBe(502);
    expect(error.message).toBe("The Antigravity codec rejected the request.");
    expect(error.message).not.toContain("xxxx");
    expect(seen.prepared).toHaveLength(6);
    const sent = await worker.officialSend({ version: 1, handle: "h", body: { project: "", model: "m", requestType: "agent", request: {} } });
    expect(sent.status).toBe(200);
    expect(sent.headers.get("content-type")).toBe("text/event-stream");
    await sent.body.cancel();
    expect(seen.sent).toHaveLength(1);
    expect(seen.sent[0]).toEqual({ version: 1, handle: "h", body: { project: "", model: "m", requestType: "agent", request: {} } });
  } finally {
    await worker.close();
    server?.stop(true);
    spawn.mockRestore();
    if (previous === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = previous;
  }
}, 10000);
