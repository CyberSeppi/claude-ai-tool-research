import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReport } from "./data.mjs";
import { createApp } from "./app.mjs";

const sample = {
  generated_at: "2026-06-29T00:00:00Z",
  query: "q",
  records: [
    { id: "a-b", name: "a/b", url: "https://github.com/a/b", category: "mcp-server", stars: 5, stars_display: "5", description: "d", efficiency_gain: "e", installed: false, installed_path: null, installed_via: null, sources: [], confidence: "high", last_researched: "2026-06-29" },
  ],
};

test("loadReport reads report.json", async () => {
  const dir = await mkdtemp(join(tmpdir(), "app-data-"));
  try {
    await writeFile(join(dir, "report.json"), JSON.stringify(sample));
    const r = loadReport(dir);
    assert.equal(r.records.length, 1);
    assert.equal(r.records[0].id, "a-b");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("loadReport tolerates missing file", () => {
  const r = loadReport("/definitely/not/here");
  assert.deepEqual(r.records, []);
  assert.equal(r.generated_at, null);
});

test("GET /api/records and POST /api/refresh", async () => {
  const dir = await mkdtemp(join(tmpdir(), "app-data-"));
  try {
    await writeFile(join(dir, "report.json"), JSON.stringify(sample));
    const app = createApp({ dataDir: dir, dbDir: join(dir, "db") });
    const res = await app.request("/api/records");
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.records.length, 1);
    const ref = await app.request("/api/refresh", { method: "POST" });
    const refBody = await ref.json();
    assert.equal(refBody.count, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
