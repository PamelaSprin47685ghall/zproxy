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

async function fakeWorker(child, run) {
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = import.meta.dir;
  const spawned = Promise.withResolvers();
  let socket;
  const spawn = spyOn(Bun, "spawn").mockImplementation(args => {
    socket = args[2];
    spawned.resolve();
    return child;
  });
  const worker = createAgWorker({ binary: "/fixture/codec" });
  try { await run(worker, spawned.promise, () => socket); }
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
