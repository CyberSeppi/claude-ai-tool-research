import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLlmConfig } from "./config.mjs";

const FULL_ENV = {
  LLM_API_KEY: "k",
  LLM_API_BASE_URL: "https://example/v1",
  LLM_AUTH_TOKEN_URL: "https://example/auth",
  LLM_AUTH_CLIENT_ID: "c",
  LLM_AUTH_CLIENT_SECRET: "s",
  LLM_AUTH_SCOPE: "machine2machine",
  LLM_MODEL: "claude-sonnet-4-6",
  LLM_MAX_COMPLETION_TOKENS: "4096",
};

test("loadLlmConfig: returns typed config when all vars present", () => {
  const cfg = loadLlmConfig(FULL_ENV);
  assert.equal(cfg.apiKey, "k");
  assert.equal(cfg.model, "claude-sonnet-4-6");
  assert.equal(cfg.maxCompletionTokens, 4096);
  assert.equal(cfg.auth.tokenUrl, "https://example/auth");
});

test("loadLlmConfig: works with just LLM_API_KEY (no OAuth)", () => {
  const cfg = loadLlmConfig({ LLM_API_KEY: "sk-ant-x" });
  assert.equal(cfg.apiKey, "sk-ant-x");
  assert.equal(cfg.apiBaseUrl, "https://api.anthropic.com/v1");
  assert.equal(cfg.model, "claude-sonnet-4-6");
  assert.equal(cfg.auth.tokenUrl, "");
});

test("loadLlmConfig: throws when LLM_API_KEY missing", () => {
  assert.throws(() => loadLlmConfig({}), /LLM_API_KEY/);
});

test("loadLlmConfig: LLM_AUTH_TOKEN_URL set → requires client_id + client_secret", () => {
  assert.throws(
    () =>
      loadLlmConfig({
        LLM_API_KEY: "k",
        LLM_AUTH_TOKEN_URL: "https://auth/example/token",
      }),
    /LLM_AUTH_CLIENT_ID.*LLM_AUTH_CLIENT_SECRET/s,
  );
});

test("loadLlmConfig: maxCompletionTokens must be a positive integer", () => {
  assert.throws(
    () => loadLlmConfig({ ...FULL_ENV, LLM_MAX_COMPLETION_TOKENS: "not-a-number" }),
    /LLM_MAX_COMPLETION_TOKENS/,
  );
});
