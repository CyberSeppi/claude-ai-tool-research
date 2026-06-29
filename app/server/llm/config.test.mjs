import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadLlmConfig } from "./config.mjs";

function withCredentials(content) {
  const dir = mkdtempSync(join(tmpdir(), "cred-"));
  const p = join(dir, ".credentials.json");
  writeFileSync(p, typeof content === "string" ? content : JSON.stringify(content));
  return { path: p, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

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

test("loadLlmConfig: cli provider skips LLM_AUTH_* validation", () => {
  // cli doesn't need LLM_AUTH_*, but it DOES need one of the Anthropic
  // credentials (ANTHROPIC_API_KEY here is the simplest).
  const cfg = loadLlmConfig({
    LLM_PROVIDER: "cli",
    LLM_MODEL: "claude-sonnet-4-6",
    ANTHROPIC_API_KEY: "k",
  });
  assert.equal(cfg.provider, "cli");
  assert.equal(cfg.model, "claude-sonnet-4-6");
});

test("loadLlmConfig: api provider throws when LLM_API_KEY missing", () => {
  assert.throws(
    () => loadLlmConfig({ LLM_PROVIDER: "api" }),
    /LLM_API_KEY/,
  );
});

test("loadLlmConfig: api works with just LLM_API_KEY (no OAuth)", () => {
  const cfg = loadLlmConfig({ LLM_PROVIDER: "api", LLM_API_KEY: "sk-ant-x" });
  assert.equal(cfg.apiKey, "sk-ant-x");
  assert.equal(cfg.apiBaseUrl, "https://api.anthropic.com/v1");
  assert.equal(cfg.auth.tokenUrl, "");
});

test("loadLlmConfig: api with LLM_AUTH_TOKEN_URL requires client_id + client_secret", () => {
  assert.throws(
    () =>
      loadLlmConfig({
        LLM_PROVIDER: "api",
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

// ── cli provider auth-mode resolution ────────────────────────────────
test("cli provider: ANTHROPIC_API_KEY → mode='api-key'", () => {
  const cfg = loadLlmConfig({ LLM_PROVIDER: "cli", ANTHROPIC_API_KEY: "sk-ant-x" });
  assert.equal(cfg.cliEffective.mode, "api-key");
  assert.equal(cfg.cliEffective.apiKey, "sk-ant-x");
});

test("cli provider: ANTHROPIC_AUTH_TOKEN → mode='oauth-token'", () => {
  const cfg = loadLlmConfig({ LLM_PROVIDER: "cli", ANTHROPIC_AUTH_TOKEN: "tok-router" });
  assert.equal(cfg.cliEffective.mode, "oauth-token");
  assert.equal(cfg.cliEffective.authToken, "tok-router");
});

test("cli provider: Pro/Max OAuth in mounted credentials → mode='mount'", () => {
  const c = withCredentials({ claudeAiOauth: { accessToken: "anth-oauth-abc" } });
  try {
    const cfg = loadLlmConfig({ LLM_PROVIDER: "cli" }, { credentialsPath: c.path });
    assert.equal(cfg.cliEffective.mode, "mount");
  } finally { c.cleanup(); }
});

test("cli provider: credentials with only mcpOAuth → mode='none' → throws", () => {
  const c = withCredentials({ mcpOAuth: {} });
  try {
    assert.throws(
      () => loadLlmConfig({ LLM_PROVIDER: "cli" }, { credentialsPath: c.path }),
      /LLM_PROVIDER=cli.*no usable Anthropic credentials/s,
    );
  } finally { c.cleanup(); }
});

test("cli provider: missing credentials file → mode='none' → throws", () => {
  assert.throws(
    () => loadLlmConfig({ LLM_PROVIDER: "cli" }, { credentialsPath: "/nonexistent" }),
    /LLM_PROVIDER=cli.*no usable Anthropic credentials/s,
  );
});

test("cli provider: ANTHROPIC_API_KEY beats mount", () => {
  const c = withCredentials({ claudeAiOauth: { accessToken: "should-be-ignored" } });
  try {
    const cfg = loadLlmConfig(
      { LLM_PROVIDER: "cli", ANTHROPIC_API_KEY: "sk-ant-win" },
      { credentialsPath: c.path },
    );
    assert.equal(cfg.cliEffective.mode, "api-key");
  } finally { c.cleanup(); }
});

test("cli provider: ANTHROPIC_BASE_URL is captured into cliEffective.baseUrl", () => {
  const cfg = loadLlmConfig({
    LLM_PROVIDER: "cli",
    ANTHROPIC_API_KEY: "k",
    ANTHROPIC_BASE_URL: "http://host.docker.internal:3456",
  });
  assert.equal(cfg.cliEffective.baseUrl, "http://host.docker.internal:3456");
});
