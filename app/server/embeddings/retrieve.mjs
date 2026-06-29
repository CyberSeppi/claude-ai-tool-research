// Top-K retriever with in-process query-embedding cache.
//
// Cache key = sha256(query), TTL 5 min. Keeps the same conversation
// from re-paying the embed-API cost on every chat turn that re-asks the
// same question.
import { createHash } from "node:crypto";

const TTL_MS = 5 * 60 * 1000;
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

export function createRetriever({ client, store, config, now = () => Date.now() }) {
  const cache = new Map();

  async function getQueryVector(query) {
    const key = sha256(query);
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return hit.vec;
    const [vec] = await client.embedBatch([query]);
    cache.set(key, { vec, expiresAt: now() + TTL_MS });
    return vec;
  }

  return {
    async topK(query, k) {
      const qVec = await getQueryVector(query);
      const limit = k ?? config.retrieval.topK;
      return store.cosineTopK(qVec, limit, config.retrieval.minScore);
    },
  };
}
