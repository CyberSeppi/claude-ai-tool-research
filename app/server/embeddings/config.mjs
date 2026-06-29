const REQUIRED = [
  "EMBEDDINGS_API_KEY",
  "EMBEDDINGS_AUTH_CLIENT_ID",
  "EMBEDDINGS_AUTH_CLIENT_SECRET",
];

function parseBool(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  return String(raw).toLowerCase() === "true";
}
function parsePositiveInt(raw, fallback, name) {
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== String(raw).trim()) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}
function parseNonNegFloat(raw, fallback, name) {
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`${name} must be a non-negative number`);
  }
  return n;
}
function isSet(v) {
  return typeof v === "string" && v.trim() !== "";
}

export function loadEmbeddingsConfig(env = process.env) {
  const enabled = parseBool(env.EMBEDDINGS_ENABLED, true);
  if (enabled) {
    const missing = REQUIRED.filter((k) => !isSet(env[k]));
    if (missing.length) {
      throw new Error(`Missing required embeddings secrets in env: ${missing.join(", ")}`);
    }
  }
  return {
    enabled,
    backfillOnStartup: parseBool(env.EMBEDDINGS_BACKFILL_ON_STARTUP, true),
    apiBaseUrl: env.EMBEDDINGS_API_BASE_URL?.trim() || "https://api.openai.com/v1",
    apiKey: env.EMBEDDINGS_API_KEY ?? "",
    model: env.EMBEDDINGS_MODEL?.trim() || "text-embedding-3-large",
    dimensions: parsePositiveInt(env.EMBEDDINGS_DIMENSIONS, 3072, "EMBEDDINGS_DIMENSIONS"),
    promptVersion: parsePositiveInt(env.EMBEDDINGS_PROMPT_VERSION, 1, "EMBEDDINGS_PROMPT_VERSION"),
    batchSize: parsePositiveInt(env.EMBEDDINGS_BATCH_SIZE, 32, "EMBEDDINGS_BATCH_SIZE"),
    chunkMaxChars: parsePositiveInt(
      env.EMBEDDINGS_CHUNK_MAX_CHARS,
      1500,
      "EMBEDDINGS_CHUNK_MAX_CHARS",
    ),
    retrieval: {
      topK: parsePositiveInt(env.EMBEDDINGS_RETRIEVAL_TOP_K, 8, "EMBEDDINGS_RETRIEVAL_TOP_K"),
      minScore: parseNonNegFloat(
        env.EMBEDDINGS_RETRIEVAL_MIN_SCORE,
        0,
        "EMBEDDINGS_RETRIEVAL_MIN_SCORE",
      ),
    },
    auth: {
      tokenUrl: env.EMBEDDINGS_AUTH_TOKEN_URL?.trim() || "",
      clientId: env.EMBEDDINGS_AUTH_CLIENT_ID ?? "",
      clientSecret: env.EMBEDDINGS_AUTH_CLIENT_SECRET ?? "",
      scope: env.EMBEDDINGS_AUTH_SCOPE?.trim() || "",
    },
    githubToken: env.GITHUB_TOKEN ?? "",
  };
}
