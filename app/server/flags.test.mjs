import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFlags, setFlag } from "./flags.mjs";
import { createApp } from "./app.mjs";

const sample = { generated_at: "t", query: "", records: [
  { id: "a-b", name: "a/b", url: "https://github.com/a/b", category: "mcp-server", stars: 5, stars_display: "5", version: null, contributors: null, description: "d", efficiency_gain: "e", sources: [], confidence: "high", last_researched: "2026-06-29" },
]};

test("setFlag persists and readFlags reads", () => {
  const dir = `${tmpdir()}/flags-${process.pid}-${Math.floor(performance.now())}`;
  const entry = setFlag(dir, "a-b", { interesting: true, note: "hot" }, new Date("2026-06-29T00:00:00Z"));
  assert.equal(entry.interesting, true);
  assert.equal(entry.note, "hot");
  const all = readFlags(dir);
  assert.equal(all["a-b"].interesting, true);
});

test("flag endpoint sets flag and records reflect it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "app-flags-"));
  try {
    await writeFile(join(dir, "report.json"), JSON.stringify(sample));
    const app = createApp({ dataDir: dir, dbDir: join(dir, "db") });
    const post = await app.request("/api/records/a-b/flag", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ interesting: true }),
    });
    assert.equal(post.status, 200);
    const res = await app.request("/api/records");
    const body = await res.json();
    assert.equal(body.records[0].flagged, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
