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
