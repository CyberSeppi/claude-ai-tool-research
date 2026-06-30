import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddingsStore } from "./store.mjs";
import { runBackfill } from "./backfill.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "bf-"));
}
function unitVec(dim, seed) {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.sin(seed * (i + 1));
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}
function makeClient(dim = 4) {
  let seed = 0;
  return {
    async embedBatch(inputs) {
      return inputs.map(() => {
        seed++;
        return unitVec(dim, seed);
      });
    },
  };
}
const RECORD = {
  id: "owner-repo",
  name: "owner/repo",
  url: "https://github.com/owner/repo",
  category: "mcp-server",
  description: "desc",
  efficiency_gain: "gain",
  use_cases: ["rag"],
};
const CFG = { model: "m", promptVersion: 1, batchSize: 8, chunkMaxChars: 1500, githubToken: "" };
const QUIET_LOG = { info: () => {}, warn: () => {} };

test("embeds fields chunk when README is unavailable", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    const result = await runBackfill({
      records: [RECORD],
      client: makeClient(),
      store,
      config: CFG,
      fetchReadmeFn: async () => null,
      log: QUIET_LOG,
    });
    assert.equal(result.embedded, 1);
    assert.equal(store.count(), 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("embeds fields + readme chunks when README present", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    const result = await runBackfill({
      records: [RECORD],
      client: makeClient(),
      store,
      config: { ...CFG, githubToken: "ghp" },
      fetchReadmeFn: async () =>
        "# Title\n\n## Section A\n\nbody A\n\n## Section B\n\nbody B",
      log: QUIET_LOG,
    });
    assert.ok(result.embedded >= 3, `expected ≥3 chunks, got ${result.embedded}`);
    assert.equal(store.count(), result.embedded);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("re-running is a no-op once the store is warm", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    await runBackfill({
      records: [RECORD],
      client: makeClient(),
      store,
      config: CFG,
      fetchReadmeFn: async () => null,
      log: QUIET_LOG,
    });
    const before = store.count();
    const second = await runBackfill({
      records: [RECORD],
      client: makeClient(),
      store,
      config: CFG,
      fetchReadmeFn: async () => null,
      log: QUIET_LOG,
    });
    assert.equal(second.embedded, 0);
    assert.equal(second.skipped, 1);
    assert.equal(store.count(), before);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("per-record failures are isolated and counted", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    const badClient = {
      async embedBatch(inputs) {
        if (inputs.some((t) => t.includes("BOOM"))) throw new Error("upstream blew up");
        return inputs.map((_, i) => unitVec(4, i + 1));
      },
    };
    const result = await runBackfill({
      records: [
        { ...RECORD, id: "good", name: "good/repo", description: "ok" },
        { ...RECORD, id: "bad", name: "bad/repo", description: "BOOM" },
      ],
      client: badClient,
      store,
      config: CFG,
      fetchReadmeFn: async () => null,
      log: QUIET_LOG,
    });
    assert.equal(result.embedded, 1);
    assert.equal(result.failed, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("empty records array → zero work, zero failures", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    const result = await runBackfill({
      records: [],
      client: makeClient(),
      store,
      config: CFG,
      fetchReadmeFn: async () => null,
      log: QUIET_LOG,
    });
    assert.deepEqual(result, { embedded: 0, skipped: 0, failed: 0 });
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backfill: non-github record (no repo_url) embeds only the fields chunk", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    let fetchCalls = 0;
    const result = await runBackfill({
      records: [
        {
          ...RECORD,
          id: "obsidian",
          name: "Obsidian",
          url: "https://obsidian.md",
          repo_url: null,
        },
      ],
      client: makeClient(),
      store,
      config: { ...CFG, githubToken: "ghp" },
      fetchReadmeFn: async () => {
        fetchCalls++;
        return "# Should not be called";
      },
      log: QUIET_LOG,
    });
    assert.equal(result.embedded, 1, "only the fields chunk");
    assert.equal(fetchCalls, 0, "no README fetch when neither repo_url nor github url");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backfill: record with repo_url uses it for the README fetch", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    let lastSlug = null;
    const result = await runBackfill({
      records: [
        {
          ...RECORD,
          id: "obsidian",
          name: "Obsidian",
          url: "https://obsidian.md",
          repo_url: "https://github.com/obsidianmd/obsidian-releases",
        },
      ],
      client: makeClient(),
      store,
      config: { ...CFG, githubToken: "ghp" },
      fetchReadmeFn: async ({ repoSlug }) => {
        lastSlug = repoSlug;
        return "# Title\n\nbody";
      },
      log: QUIET_LOG,
    });
    assert.equal(lastSlug, "obsidianmd/obsidian-releases");
    assert.ok(result.embedded >= 2, "fields + readme chunks");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
