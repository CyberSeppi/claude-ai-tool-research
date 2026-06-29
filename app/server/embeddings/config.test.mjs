import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEmbeddingsConfig } from "./config.mjs";

const SECRETS = {
  EMBEDDINGS_API_KEY: "k",
  EMBEDDINGS_AUTH_CLIENT_ID: "c",
  EMBEDDINGS_AUTH_CLIENT_SECRET: "s",
};

test("defaults applied when only secrets set", () => {
  const cfg = loadEmbeddingsConfig(SECRETS);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.backfillOnStartup, true);
  assert.equal(cfg.apiBaseUrl, "https://api.openai.com/v1");
  assert.equal(cfg.model, "text-embedding-3-large");
  assert.equal(cfg.dimensions, 3072);
  assert.equal(cfg.promptVersion, 1);
  assert.equal(cfg.batchSize, 32);
  assert.equal(cfg.chunkMaxChars, 1500);
  assert.equal(cfg.retrieval.topK, 8);
  assert.equal(cfg.retrieval.minScore, 0);
});

test("enabled=false skips required-secret validation", () => {
  const cfg = loadEmbeddingsConfig({ EMBEDDINGS_ENABLED: "false" });
  assert.equal(cfg.enabled, false);
});

test("enabled=true with no secrets throws listing all missing keys", () => {
  assert.throws(
    () => loadEmbeddingsConfig({}),
    /EMBEDDINGS_API_KEY.*EMBEDDINGS_AUTH_CLIENT_ID.*EMBEDDINGS_AUTH_CLIENT_SECRET/s,
  );
});

test("GITHUB_TOKEN passed through; empty is fine", () => {
  const cfg = loadEmbeddingsConfig({ ...SECRETS, GITHUB_TOKEN: "" });
  assert.equal(cfg.githubToken, "");
});

test("GITHUB_TOKEN set is captured", () => {
  const cfg = loadEmbeddingsConfig({ ...SECRETS, GITHUB_TOKEN: "ghp_abc" });
  assert.equal(cfg.githubToken, "ghp_abc");
});

test("EMBEDDINGS_DIMENSIONS must be positive integer", () => {
  assert.throws(
    () => loadEmbeddingsConfig({ ...SECRETS, EMBEDDINGS_DIMENSIONS: "-1" }),
    /EMBEDDINGS_DIMENSIONS/,
  );
});

test("EMBEDDINGS_RETRIEVAL_MIN_SCORE accepts floats", () => {
  const cfg = loadEmbeddingsConfig({ ...SECRETS, EMBEDDINGS_RETRIEVAL_MIN_SCORE: "0.3" });
  assert.equal(cfg.retrieval.minScore, 0.3);
});

test("EMBEDDINGS_AUTH_TOKEN_URL set => OAuth M2M block captured", () => {
  const cfg = loadEmbeddingsConfig({
    ...SECRETS,
    EMBEDDINGS_AUTH_TOKEN_URL: "https://iam/token",
    EMBEDDINGS_AUTH_SCOPE: "scope-a",
  });
  assert.equal(cfg.auth.tokenUrl, "https://iam/token");
  assert.equal(cfg.auth.scope, "scope-a");
});
