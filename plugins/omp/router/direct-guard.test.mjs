import { expect, test } from "bun:test";
import { sanitizeDirectError, sanitizeDirectResponse } from "./direct-guard.mjs";

const jsonResponse = (status, body) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

test("a provider 402 keeps its status and body", async () => {
  const response = await sanitizeDirectResponse(
    jsonResponse(402, { error: { type: "insufficient_quota", message: "add credit at provider.example" } }),
  );
  expect(response.status).toBe(402);
  expect(await response.json()).toEqual({ error: { type: "insufficient_quota", message: "add credit at provider.example" } });
});

test("a genuine request error keeps its own status and body", async () => {
  const response = await sanitizeDirectResponse(jsonResponse(400, { error: { message: "bad field" } }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: { message: "bad field" } });
});

test("a quota-worded account-status reply is replaced", async () => {
  for (const status of [401, 403, 429]) {
    const response = await sanitizeDirectResponse(
      jsonResponse(status, { error: { message: "insufficient credits" } }),
    );
    expect(response.status).toBe(503);
  }
});

test("a local refusal without quota wording keeps its status", async () => {
  const response = await sanitizeDirectResponse(jsonResponse(401, { error: { message: "no credential" } }));
  expect(response.status).toBe(401);
});

test("a streaming 200 that opens with an error frame becomes a 503", async () => {
  const response = await sanitizeDirectResponse(
    new Response('data: {"error":{"message":"insufficient credits"}}\n\n', {
      headers: { "content-type": "text/event-stream" },
    }),
  );
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("insufficient credits");
});

test("a streaming API-budget error frame keeps the stream intact", async () => {
  const body = 'data: {"error":{"type":"billing_api_budget_exhausted","message":"API budget exhausted."}}\n\n';
  const response = await sanitizeDirectResponse(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(body);
});

test("a normal streaming answer is replayed byte for byte", async () => {
  const body =
    'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
    'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n';
  const response = await sanitizeDirectResponse(
    new Response(body, { headers: { "content-type": "text/event-stream" } }),
  );
  expect(response.status).toBe(200);
  expect(await response.text()).toBe(body);
});

test("a thrown 402 keeps the provider status", () => {
  const response = sanitizeDirectError(Object.assign(new Error("HTTP 402: payment required"), { status: 402 }));
  expect(response).toBeUndefined();
});
