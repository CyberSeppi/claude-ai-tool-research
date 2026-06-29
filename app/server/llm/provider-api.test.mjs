import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiProvider } from "./provider-api.mjs";

const cfg = {
  provider: "api",
  apiBaseUrl: "https://api.gcp.cloud.bmw/llmapi/v1",
  apiKey: "K",
  model: "gpt-4o",
  maxCompletionTokens: 256,
  auth: {},
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

test("chat: posts to {base}/chat/completions with auth + apikey headers", async () => {
  const { fetchImpl, calls } = makeFetch(
    async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }),
        { status: 200 },
      ),
  );
  const provider = createApiProvider({ getConfig: () => cfg, oauth, fetchImpl });
  const answer = await provider.chat([{ role: "user", content: "ping" }]);
  assert.equal(answer, "hi");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.gcp.cloud.bmw/llmapi/v1/chat/completions");
  assert.equal(calls[0].init.headers["Authorization"], "Bearer TKN");
  assert.equal(calls[0].init.headers["x-apikey"], "K");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "gpt-4o");
  assert.equal(body.max_completion_tokens, 256);
  assert.deepEqual(body.messages, [{ role: "user", content: "ping" }]);
});

test("chat: non-2xx throws with upstream status", async () => {
  const { fetchImpl } = makeFetch(async () => new Response("boom", { status: 500 }));
  const provider = createApiProvider({ getConfig: () => cfg, oauth, fetchImpl });
  await assert.rejects(
    () => provider.chat([{ role: "user", content: "x" }]),
    /LLM upstream failed: 500/,
  );
});

test("chat: empty choices array surfaces an error", async () => {
  const { fetchImpl } = makeFetch(
    async () => new Response(JSON.stringify({ choices: [] }), { status: 200 }),
  );
  const provider = createApiProvider({ getConfig: () => cfg, oauth, fetchImpl });
  await assert.rejects(
    () => provider.chat([{ role: "user", content: "x" }]),
    /no content/,
  );
});
