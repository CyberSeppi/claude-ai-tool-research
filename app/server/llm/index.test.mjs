import { test } from "node:test";
import assert from "node:assert/strict";
import { createLlmClient } from "./index.mjs";

const apiEnv = {
  LLM_PROVIDER: "api",
  LLM_API_KEY: "k",
  LLM_AUTH_CLIENT_ID: "c",
  LLM_AUTH_CLIENT_SECRET: "s",
  LLM_API_BASE_URL: "https://api/llmapi/v1",
};

test("createLlmClient: selects api provider by default and passes oauth", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ access_token: "T", expires_in: 3600 }), { status: 200 });
  const calls = [];
  const factories = {
    api: ({ getConfig, oauth }) => ({
      async chat(msgs) {
        calls.push({
          provider: "api",
          msgs,
          cfg: getConfig(),
          tok: await oauth.getAccessToken(),
        });
        return "api-ok";
      },
    }),
    cli: () => {
      throw new Error("cli should not be picked");
    },
  };
  const client = createLlmClient({ env: apiEnv, fetchImpl, providerFactories: factories });
  assert.equal(await client.chat([{ role: "user", content: "hi" }]), "api-ok");
  assert.equal(calls[0].provider, "api");
  assert.equal(calls[0].tok, "T");
});

test("createLlmClient: cli provider does not require API secrets", () => {
  const factories = {
    api: () => {
      throw new Error("api should not be picked");
    },
    cli: () => ({ chat: async () => "cli-ok" }),
  };
  const client = createLlmClient({
    env: { LLM_PROVIDER: "cli", ANTHROPIC_API_KEY: "k" },
    providerFactories: factories,
  });
  assert.equal(client.getConfig().provider, "cli");
});

test("createLlmClient: surfaces config errors at construction time", () => {
  assert.throws(
    () => createLlmClient({ env: { LLM_PROVIDER: "api" } }),
    /Missing required LLM secrets/,
  );
});
