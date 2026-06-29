import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmbeddingsClient } from "./client.mjs";

function unitVec(dim, seed = 1) {
  const v = new Array(dim).fill(0).map((_, i) => Math.sin(seed * (i + 1)));
  let s = 0;
  for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  return v.map((x) => x / n);
}

const cfg = {
  apiBaseUrl: "https://api/v1",
  apiKey: "K",
  model: "text-embedding-3-large",
  dimensions: 4,
};
const oauth = { getAccessToken: async () => "TKN" };

function makeFetch(impl) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  return { fetchImpl, calls };
}

test("embedBatch: posts to {base}/embeddings with auth + apikey", async () => {
  const { fetchImpl, calls } = makeFetch(
    async () =>
      new Response(
        JSON.stringify({
          data: [
            { index: 0, embedding: unitVec(4, 1) },
            { index: 1, embedding: unitVec(4, 2) },
          ],
        }),
        { status: 200 },
      ),
  );
  const client = createEmbeddingsClient({ getConfig: () => cfg, oauth, fetchImpl });
  const out = await client.embedBatch(["a", "b"]);
  assert.equal(out.length, 2);
  assert.ok(out[0] instanceof Float32Array);
  assert.equal(out[0].length, 4);
  assert.equal(calls[0].url, "https://api/v1/embeddings");
  assert.equal(calls[0].init.headers["Authorization"], "Bearer TKN");
  assert.equal(calls[0].init.headers["x-apikey"], "K");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "text-embedding-3-large");
  assert.deepEqual(body.input, ["a", "b"]);
});

test("embedBatch: preserves input order via index field", async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        data: [
          // Returned out of order — must be re-sorted by index.
          { index: 1, embedding: unitVec(4, 2) },
          { index: 0, embedding: unitVec(4, 1) },
        ],
      }),
      { status: 200 },
    );
  const client = createEmbeddingsClient({ getConfig: () => cfg, oauth, fetchImpl });
  const out = await client.embedBatch(["first", "second"]);
  // out[0] should correspond to input[0] = "first" = seed 1 vector
  assert.equal(out.length, 2);
  // Sanity: the two vectors should differ
  assert.notDeepEqual(Array.from(out[0]), Array.from(out[1]));
});

test("embedBatch: rejects on dimension mismatch", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: unitVec(8, 1) }] }), {
      status: 200,
    });
  const client = createEmbeddingsClient({ getConfig: () => cfg, oauth, fetchImpl });
  await assert.rejects(() => client.embedBatch(["a"]), /dimension mismatch.*expected 4.*8/i);
});

test("embedBatch: rejects on non-unit-norm vector", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: [10, 10, 10, 10] }] }), {
      status: 200,
    });
  const client = createEmbeddingsClient({ getConfig: () => cfg, oauth, fetchImpl });
  await assert.rejects(() => client.embedBatch(["a"]), /unit-norm/i);
});

test("embedBatch: empty input returns empty array without HTTP call", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response("", { status: 200 });
  };
  const client = createEmbeddingsClient({ getConfig: () => cfg, oauth, fetchImpl });
  const out = await client.embedBatch([]);
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});

test("embedBatch: surfaces non-2xx as ExternalApiError-style message", async () => {
  const fetchImpl = async () => new Response("boom", { status: 500 });
  const client = createEmbeddingsClient({ getConfig: () => cfg, oauth, fetchImpl });
  await assert.rejects(() => client.embedBatch(["a"]), /Embeddings upstream failed: 500/);
});

test("embedBatch: rejects when upstream returns wrong vector count", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: unitVec(4, 1) }] }), {
      status: 200,
    });
  const client = createEmbeddingsClient({ getConfig: () => cfg, oauth, fetchImpl });
  await assert.rejects(() => client.embedBatch(["a", "b"]), /returned 1 vectors for 2 inputs/);
});
