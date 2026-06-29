import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.mjs";

test("GET /api/health returns ok", async () => {
  const app = createApp({ dataDir: "/nonexistent", dbDir: "/tmp/effres-db-test" });
  const res = await app.request("/api/health");
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.ok, true);
});

test("POST /api/chat 503 when no llm injected", async () => {
  const app = createApp({ dataDir: "/nonexistent", dbDir: "/tmp/effres-db-test" });
  const res = await app.request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "global", message: "hi" }),
  });
  assert.equal(res.status, 503);
});

test("POST /api/chat 400 on empty message", async () => {
  const llm = { chat: async () => "" };
  const app = createApp({ dataDir: "/nonexistent", dbDir: "/tmp/effres-db-test", llm });
  const res = await app.request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "global", message: "" }),
  });
  assert.equal(res.status, 400);
});

test("POST /api/chat returns answer + retrieval mode", async () => {
  const llm = { chat: async () => "stubbed" };
  const app = createApp({
    dataDir: "/nonexistent",
    dbDir: "/tmp/effres-db-test",
    llm,
    embeddingsCfg: { enabled: false },
  });
  const res = await app.request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ scope: "global", message: "hi" }),
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.answer, "stubbed");
  assert.equal(body.retrieval.mode, "full-context");
});
