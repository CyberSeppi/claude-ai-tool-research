import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLlmConfig } from "./config.mjs";

const FULL_ENV = {
  LLM_PROVIDER: "api",
  LLM_API_KEY: "k",
  LLM_AUTH_CLIENT_ID: "c",
  LLM_AUTH_CLIENT_SECRET: "s",
  LLM_API_BASE_URL: "https://example/llmapi/v1",
  LLM_AUTH_TOKEN_URL: "https://example/auth",
  LLM_AUTH_SCOPE: "machine2machine",
  LLM_MODEL: "gpt-4o",
  LLM_MAX_COMPLETION_TOKENS: "4096",
};

test("loadLlmConfig: returns typed config when all vars present", () => {
  const cfg = loadLlmConfig(FULL_ENV);
  assert.equal(cfg.provider, "api");
  assert.equal(cfg.apiKey, "k");
  assert.equal(cfg.model, "gpt-4o");
  assert.equal(cfg.maxCompletionTokens, 4096);
  assert.equal(cfg.auth.tokenUrl, "https://example/auth");
});

test("loadLlmConfig: defaults provider to 'api' when LLM_PROVIDER unset", () => {
  const { LLM_PROVIDER: _, ...env } = FULL_ENV;
  const cfg = loadLlmConfig(env);
  assert.equal(cfg.provider, "api");
});

test("loadLlmConfig: cli provider skips secret validation", () => {
  const cfg = loadLlmConfig({ LLM_PROVIDER: "cli", LLM_MODEL: "claude-sonnet-4-6" });
  assert.equal(cfg.provider, "cli");
  assert.equal(cfg.model, "claude-sonnet-4-6");
});

test("loadLlmConfig: api provider throws listing every missing secret", () => {
  assert.throws(
    () => loadLlmConfig({ LLM_PROVIDER: "api" }),
    /LLM_API_KEY.*LLM_AUTH_CLIENT_ID.*LLM_AUTH_CLIENT_SECRET/s,
  );
});

test("loadLlmConfig: maxCompletionTokens must be a positive integer", () => {
  assert.throws(
    () => loadLlmConfig({ ...FULL_ENV, LLM_MAX_COMPLETION_TOKENS: "not-a-number" }),
    /LLM_MAX_COMPLETION_TOKENS/,
  );
});
