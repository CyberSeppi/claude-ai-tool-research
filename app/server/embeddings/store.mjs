// SQLite-backed embedded_chunks store.
//
// Vectors are stored as raw Float32Array bytes in a BLOB column. At
// 3072 dims × 4 bytes that's 12 288 bytes per row; brute-force JS
// cosine over <2 000 rows runs in well under 10 ms. No native vector
// extension required.
//
// Idempotent upserts are keyed by (record_id, chunk_index, model,
// prompt_version). The text_hash column is sha256(text) — useful as
// a "skip if already embedded" gate at the backfill layer.
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS embedded_chunks (
  record_id      TEXT NOT NULL,
  chunk_index    INTEGER NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('fields', 'readme')),
  heading_path   TEXT,
  text           TEXT NOT NULL,
  text_hash      TEXT NOT NULL,
  model          TEXT NOT NULL,
  vector         BLOB NOT NULL,
  prompt_version INTEGER NOT NULL DEFAULT 1,
  embedded_at    TEXT NOT NULL,
  PRIMARY KEY (record_id, chunk_index, model, prompt_version)
);
CREATE INDEX IF NOT EXISTS idx_chunks_text_hash ON embedded_chunks(text_hash);
`;

function vecToBuf(v) {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
function bufToVec(b) {
  // Copy into a fresh ArrayBuffer to be safe against alignment / lifetime
  // issues from the underlying SQLite buffer.
  const ab = new ArrayBuffer(b.byteLength);
  new Uint8Array(ab).set(b);
  return new Float32Array(ab);
}
// Both inputs are L2-normalized → cosine = dot product.
function cosine(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function createEmbeddingsStore({ dbPath, model, promptVersion }) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const stmts = {
    has: db.prepare(
      `SELECT 1 FROM embedded_chunks
       WHERE record_id = ? AND chunk_index = ? AND model = ? AND prompt_version = ?`,
    ),
    upsert: db.prepare(`
      INSERT INTO embedded_chunks
        (record_id, chunk_index, source, heading_path, text, text_hash,
         model, vector, prompt_version, embedded_at)
      VALUES
        (@record_id, @chunk_index, @source, @heading_path, @text, @text_hash,
         @model, @vector, @prompt_version, @embedded_at)
      ON CONFLICT(record_id, chunk_index, model, prompt_version) DO UPDATE SET
        source = excluded.source,
        heading_path = excluded.heading_path,
        text = excluded.text,
        text_hash = excluded.text_hash,
        vector = excluded.vector,
        embedded_at = excluded.embedded_at
    `),
    all: db.prepare(
      `SELECT * FROM embedded_chunks WHERE model = ? AND prompt_version = ?`,
    ),
    count: db.prepare(
      `SELECT COUNT(*) AS c FROM embedded_chunks WHERE model = ? AND prompt_version = ?`,
    ),
    distinctRecordIds: db.prepare(
      `SELECT DISTINCT record_id FROM embedded_chunks
       WHERE model = ? AND prompt_version = ?`,
    ),
    deleteByRecord: db.prepare(
      `DELETE FROM embedded_chunks
       WHERE record_id = ? AND model = ? AND prompt_version = ?`,
    ),
  };

  function upsertChunks(rows) {
    const now = new Date().toISOString();
    const tx = db.transaction((rs) => {
      for (const r of rs) {
        stmts.upsert.run({
          record_id: r.recordId,
          chunk_index: r.chunkIndex,
          source: r.source,
          heading_path: r.headingPath,
          text: r.text,
          text_hash: r.textHash,
          model,
          vector: vecToBuf(r.vector),
          prompt_version: promptVersion,
          embedded_at: now,
        });
      }
    });
    tx(rows);
  }

  function hasChunk(recordId, chunkIndex) {
    return stmts.has.get(recordId, chunkIndex, model, promptVersion) !== undefined;
  }

  function allChunks() {
    return stmts.all.all(model, promptVersion).map((r) => ({
      recordId: r.record_id,
      chunkIndex: r.chunk_index,
      source: r.source,
      headingPath: r.heading_path,
      text: r.text,
      vector: bufToVec(r.vector),
    }));
  }

  function count() {
    return stmts.count.get(model, promptVersion).c;
  }

  function listRecordIds() {
    return stmts.distinctRecordIds.all(model, promptVersion).map((r) => r.record_id);
  }

  // Drop all chunks for the given record_ids (scoped to this store's
  // (model, prompt_version) namespace). Wrapped in a transaction so a
  // bulk delete from the boot-time prune is atomic.
  function deleteRecords(recordIds) {
    if (!recordIds.length) return 0;
    const tx = db.transaction((ids) => {
      let n = 0;
      for (const id of ids) {
        const r = stmts.deleteByRecord.run(id, model, promptVersion);
        n += r.changes;
      }
      return n;
    });
    return tx(recordIds);
  }

  function cosineTopK(query, k, minScore) {
    const rows = allChunks();
    const scored = [];
    for (const r of rows) {
      if (r.vector.length !== query.length) continue;
      const s = cosine(query, r.vector);
      if (s >= minScore) scored.push({ row: r, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const out = [];
    for (const s of scored) {
      if (seen.has(s.row.recordId)) continue;
      seen.add(s.row.recordId);
      out.push({
        recordId: s.row.recordId,
        chunkIndex: s.row.chunkIndex,
        score: s.score,
        headingPath: s.row.headingPath,
      });
      if (out.length === k) break;
    }
    return out;
  }

  return {
    upsertChunks,
    hasChunk,
    allChunks,
    count,
    cosineTopK,
    listRecordIds,
    deleteRecords,
    close: () => db.close(),
  };
}
