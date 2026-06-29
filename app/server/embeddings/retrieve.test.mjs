import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddingsStore } from "./store.mjs";
import { createRetriever } from "./retrieve.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "rt-"));
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

test("topK returns the most similar records (one entry per record)", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    const a = unitVec(4, 1);
    const b = unitVec(4, 2);
    store.upsertChunks([
      {
        recordId: "r1",
        chunkIndex: 0,
        source: "fields",
        headingPath: null,
        text: "t",
        textHash: "h",
        vector: a,
      },
      {
        recordId: "r2",
        chunkIndex: 0,
        source: "fields",
        headingPath: null,
        text: "t",
        textHash: "h",
        vector: b,
      },
    ]);
    const client = { embedBatch: async () => [a] };
    const ret = createRetriever({
      client,
      store,
      config: { retrieval: { topK: 2, minScore: 0 } },
    });
    const hits = await ret.topK("q");
    assert.equal(hits[0].recordId, "r1");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("topK caches the query embedding (same query → one embedBatch call)", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    store.upsertChunks([
      {
        recordId: "r1",
        chunkIndex: 0,
        source: "fields",
        headingPath: null,
        text: "t",
        textHash: "h",
        vector: unitVec(4, 1),
      },
    ]);
    let embedCalls = 0;
    const client = {
      embedBatch: async () => {
        embedCalls++;
        return [unitVec(4, 1)];
      },
    };
    const ret = createRetriever({
      client,
      store,
      config: { retrieval: { topK: 1, minScore: 0 } },
      now: () => 0,
    });
    await ret.topK("same query");
    await ret.topK("same query");
    assert.equal(embedCalls, 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("topK cache evicts after TTL", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    store.upsertChunks([
      {
        recordId: "r1",
        chunkIndex: 0,
        source: "fields",
        headingPath: null,
        text: "t",
        textHash: "h",
        vector: unitVec(4, 1),
      },
    ]);
    let embedCalls = 0;
    const client = {
      embedBatch: async () => {
        embedCalls++;
        return [unitVec(4, 1)];
      },
    };
    let t = 0;
    const ret = createRetriever({
      client,
      store,
      config: { retrieval: { topK: 1, minScore: 0 } },
      now: () => t,
    });
    await ret.topK("q");
    t = 10 * 60 * 1000; // 10 min later
    await ret.topK("q");
    assert.equal(embedCalls, 2);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("topK passes k override when given", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    for (let i = 0; i < 5; i++) {
      store.upsertChunks([
        {
          recordId: `r${i}`,
          chunkIndex: 0,
          source: "fields",
          headingPath: null,
          text: "t",
          textHash: `h${i}`,
          vector: unitVec(4, i + 1),
        },
      ]);
    }
    const client = { embedBatch: async () => [unitVec(4, 1)] };
    const ret = createRetriever({
      client,
      store,
      config: { retrieval: { topK: 8, minScore: 0 } },
    });
    const hits = await ret.topK("q", 2);
    assert.equal(hits.length, 2);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
