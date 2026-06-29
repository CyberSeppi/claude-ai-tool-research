import { test } from "node:test";
import assert from "node:assert/strict";
import { createLlmClient } from "./index.mjs";

const apiEnv = {
  LLM_API_KEY: "k",
  LLM_API_BASE_URL: "https://api/v1",
  // OAuth M2M block — provider exercises the OAuth path so we assert
  // the bearer token flows through to chat().
  LLM_AUTH_TOKEN_URL: "https://auth/example/token",
  LLM_AUTH_CLIENT_ID: "c",
  LLM_AUTH_CLIENT_SECRET: "s",
};

test("createLlmClient: wires oauth + provider with injected factories", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ access_token: "T", expires_in: 3600 }), { status: 200 });
  const calls = [];
  const providerFactory = ({ getConfig, oauth }) => ({
    async chat(msgs) {
      calls.push({ msgs, cfg: getConfig(), tok: await oauth.getAccessToken() });
      return "ok";
    },
  });
  const client = createLlmClient({ env: apiEnv, fetchImpl, providerFactory });
  assert.equal(await client.chat([{ role: "user", content: "hi" }]), "ok");
  assert.equal(calls[0].tok, "T");
});

test("createLlmClient: surfaces config errors at construction time", () => {
  assert.throws(() => createLlmClient({ env: {} }), /Missing required LLM secrets/);
});
