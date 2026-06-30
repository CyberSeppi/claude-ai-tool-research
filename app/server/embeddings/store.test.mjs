import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddingsStore } from "./store.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "emb-"));
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

test("upsertChunks + allChunks: round-trips vectors as Float32Array", () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    const vec = unitVec(8, 1);
    store.upsertChunks([
      {
        recordId: "r1",
        chunkIndex: 0,
        source: "fields",
        headingPath: null,
        text: "t",
        textHash: "h",
        vector: vec,
      },
    ]);
    const rows = store.allChunks();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].recordId, "r1");
    assert.ok(rows[0].vector instanceof Float32Array);
    assert.equal(rows[0].vector.length, 8);
    for (let i = 0; i < 8; i++) assert.ok(Math.abs(rows[0].vector[i] - vec[i]) < 1e-6);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hasChunk: scopes by model and promptVersion", () => {
  const dir = tmp();
  try {
    const path = join(dir, "x.sqlite");
    const s1 = createEmbeddingsStore({ dbPath: path, model: "m1", promptVersion: 1 });
    s1.upsertChunks([
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
    assert.equal(s1.hasChunk("r1", 0), true);
    s1.close();

    const s2 = createEmbeddingsStore({ dbPath: path, model: "m2", promptVersion: 1 });
    assert.equal(s2.hasChunk("r1", 0), false, "different model is a separate row");
    s2.close();

    const s3 = createEmbeddingsStore({ dbPath: path, model: "m1", promptVersion: 2 });
    assert.equal(s3.hasChunk("r1", 0), false, "different promptVersion is a separate row");
    s3.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cosineTopK: returns the best chunk per record, sorted by score", () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    const a = unitVec(4, 1);
    const b = unitVec(4, 2);
    const c = unitVec(4, 3);
    store.upsertChunks([
      {
        recordId: "r1",
        chunkIndex: 0,
        source: "fields",
        headingPath: null,
        text: "ta",
        textHash: "ha",
        vector: a,
      },
      {
        recordId: "r1",
        chunkIndex: 1,
        source: "readme",
        headingPath: "r1: h",
        text: "tb",
        textHash: "hb",
        vector: b,
      },
      {
        recordId: "r2",
        chunkIndex: 0,
        source: "fields",
        headingPath: null,
        text: "tc",
        textHash: "hc",
        vector: c,
      },
    ]);
    const out = store.cosineTopK(a, 5, 0);
    assert.equal(out[0].recordId, "r1");
    assert.equal(out[0].chunkIndex, 0); // best chunk for r1 is the perfect match
    assert.equal(out.length, 2); // one entry per record after collapse
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cosineTopK: respects minScore floor", () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    const a = unitVec(4, 1);
    const b = unitVec(4, 5);
    store.upsertChunks([
      {
        recordId: "r1",
        chunkIndex: 0,
        source: "fields",
        headingPath: null,
        text: "ta",
        textHash: "ha",
        vector: a,
      },
      {
        recordId: "r2",
        chunkIndex: 0,
        source: "fields",
        headingPath: null,
        text: "tb",
        textHash: "hb",
        vector: b,
      },
    ]);
    const out = store.cosineTopK(a, 5, 0.999);
    assert.equal(out.length, 1, "only the near-perfect match survives the floor");
    assert.equal(out[0].recordId, "r1");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upsertChunks: re-inserting same key updates the row", () => {
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
        text: "old",
        textHash: "h1",
        vector: unitVec(4, 1),
      },
    ]);
    store.upsertChunks([
      {
        recordId: "r1",
        chunkIndex: 0,
        source: "fields",
        headingPath: null,
        text: "new",
        textHash: "h2",
        vector: unitVec(4, 1),
      },
    ]);
    assert.equal(store.count(), 1);
    assert.equal(store.allChunks()[0].text, "new");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("count returns 0 for empty store", () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    assert.equal(store.count(), 0);
    assert.deepEqual(store.allChunks(), []);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("listRecordIds + deleteRecords: removes all chunks for given ids", () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    store.upsertChunks([
      { recordId: "keep", chunkIndex: 0, source: "fields", headingPath: null, text: "k", textHash: "h1", vector: unitVec(4, 1) },
      { recordId: "drop", chunkIndex: 0, source: "fields", headingPath: null, text: "d", textHash: "h2", vector: unitVec(4, 2) },
      { recordId: "drop", chunkIndex: 1, source: "readme", headingPath: "drop: h", text: "d2", textHash: "h3", vector: unitVec(4, 3) },
    ]);
    assert.deepEqual(store.listRecordIds().sort(), ["drop", "keep"]);
    const removed = store.deleteRecords(["drop", "nonexistent"]);
    assert.equal(removed, 2, "two chunks deleted for 'drop'");
    assert.deepEqual(store.listRecordIds(), ["keep"]);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteRecords: empty input is a no-op", () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    store.upsertChunks([
      { recordId: "r1", chunkIndex: 0, source: "fields", headingPath: null, text: "t", textHash: "h", vector: unitVec(4, 1) },
    ]);
    assert.equal(store.deleteRecords([]), 0);
    assert.equal(store.count(), 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
