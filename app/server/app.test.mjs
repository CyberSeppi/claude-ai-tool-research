import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

test("POST /api/seeds/enrich: returns preview without saving", async () => {
  const enrich = async (input) => ({
    name: input.name || "X",
    url: input.url,
    repo_url: null,
    category: "companion-app",
    description: "preview desc",
    efficiency_gain: "preview gain",
    use_cases: ["test"],
    sources: [input.url],
    confidence: "medium",
    stars: null,
    stars_display: null,
    version: null,
    contributors: null,
    free: true,
    free_check_reason: "preview",
  });
  const dbDir = await mkdtemp(join(tmpdir(), "app-db-"));
  const dataDir = await mkdtemp(join(tmpdir(), "app-data-"));
  try {
    const app = createApp({ dataDir, dbDir, enrich });
    const res = await app.request("/api/seeds/enrich", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", name: "Example" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enriched.name, "Example");
    assert.equal(body.enriched.category, "companion-app");
    // Did NOT save
    const list = await app.request("/api/records");
    const listBody = await list.json();
    assert.equal(listBody.records.length, 0);
  } finally {
    await rm(dbDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /api/seeds: validates required fields", async () => {
  const dbDir = await mkdtemp(join(tmpdir(), "app-db-"));
  const dataDir = await mkdtemp(join(tmpdir(), "app-data-"));
  try {
    const app = createApp({ dataDir, dbDir });
    const res = await app.request("/api/seeds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Only name" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /url/i);
  } finally {
    await rm(dbDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /api/seeds: saves a valid seed + invokes indexer", async () => {
  const dbDir = await mkdtemp(join(tmpdir(), "app-db-"));
  const dataDir = await mkdtemp(join(tmpdir(), "app-data-"));
  let indexedRec = null;
  const indexer = (rec) => {
    indexedRec = rec;
  };
  try {
    const app = createApp({ dataDir, dbDir, indexer });
    const res = await app.request("/api/seeds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Obsidian",
        url: "https://obsidian.md",
        category: "companion-app",
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.seed.name, "Obsidian");
    // indexer should have been scheduled (we await one microtask)
    await new Promise((r) => setImmediate(r));
    assert.ok(indexedRec, "indexer was called");
    assert.equal(indexedRec.name, "Obsidian");
  } finally {
    await rm(dbDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /api/seeds: 409 with existing='seed' on duplicate", async () => {
  const dbDir = await mkdtemp(join(tmpdir(), "app-db-"));
  const dataDir = await mkdtemp(join(tmpdir(), "app-data-"));
  try {
    const app = createApp({ dataDir, dbDir });
    const body = JSON.stringify({
      name: "Obsidian",
      url: "https://obsidian.md",
      category: "companion-app",
    });
    const opts = { method: "POST", headers: { "content-type": "application/json" }, body };
    await app.request("/api/seeds", opts);
    const res = await app.request("/api/seeds", opts);
    assert.equal(res.status, 409);
    const j = await res.json();
    assert.equal(j.existing, "seed");
  } finally {
    await rm(dbDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /api/seeds: 409 with existing='raw' when slug already in raw-records", async () => {
  const dbDir = await mkdtemp(join(tmpdir(), "app-db-"));
  const dataDir = await mkdtemp(join(tmpdir(), "app-data-"));
  try {
    await writeFile(
      join(dataDir, "report.json"),
      JSON.stringify({
        generated_at: "t",
        records: [
          {
            id: "x-y",
            name: "x/y",
            url: "https://github.com/x/y",
            repo_url: "https://github.com/x/y",
            category: "plugin-skill",
            description: "",
            efficiency_gain: "",
            use_cases: [],
            sources: [],
            confidence: "high",
          },
        ],
      }),
    );
    const app = createApp({ dataDir, dbDir });
    const res = await app.request("/api/seeds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "x/y",
        url: "https://github.com/x/y",
        category: "plugin-skill",
      }),
    });
    assert.equal(res.status, 409);
    const j = await res.json();
    assert.equal(j.existing, "raw");
  } finally {
    await rm(dbDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("PATCH /api/seeds/:slug updates a seed", async () => {
  const dbDir = await mkdtemp(join(tmpdir(), "app-db-"));
  const dataDir = await mkdtemp(join(tmpdir(), "app-data-"));
  try {
    const app = createApp({ dataDir, dbDir });
    await app.request("/api/seeds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Obsidian",
        url: "https://obsidian.md",
        category: "companion-app",
      }),
    });
    const res = await app.request("/api/seeds/obsidian", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "updated" }),
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.seed.description, "updated");
  } finally {
    await rm(dbDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DELETE /api/seeds/:slug removes a seed", async () => {
  const dbDir = await mkdtemp(join(tmpdir(), "app-db-"));
  const dataDir = await mkdtemp(join(tmpdir(), "app-data-"));
  try {
    const app = createApp({ dataDir, dbDir });
    await app.request("/api/seeds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Obsidian",
        url: "https://obsidian.md",
        category: "companion-app",
      }),
    });
    const res = await app.request("/api/seeds/obsidian", { method: "DELETE" });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.deleted, true);
  } finally {
    await rm(dbDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});
