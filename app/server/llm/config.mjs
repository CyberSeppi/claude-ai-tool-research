// LLM_API_KEY is always required when LLM_PROVIDER=api.
// LLM_AUTH_* are OPTIONAL — only validate them when the user has set
// LLM_AUTH_TOKEN_URL (signal that this endpoint uses OAuth M2M on top
// of the API key). Anthropic direct and OpenAI direct do NOT need them.
const REQUIRED_API_KEY = "LLM_API_KEY";
const OAUTH_REQUIRED_WHEN_TOKEN_URL_SET = [
  "LLM_AUTH_CLIENT_ID",
  "LLM_AUTH_CLIENT_SECRET",
];

function parsePositiveInt(raw, fallback, name) {
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== String(raw).trim()) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

function isSet(v) {
  return typeof v === "string" && v.trim() !== "";
}

export function loadLlmConfig(env = process.env) {
  const provider = (env.LLM_PROVIDER ?? "api").trim() || "api";
  if (provider !== "api" && provider !== "cli") {
    throw new Error(`LLM_PROVIDER must be 'api' or 'cli' (got '${provider}')`);
  }

  if (provider === "api") {
    const missing = [];
    if (!isSet(env[REQUIRED_API_KEY])) missing.push(REQUIRED_API_KEY);
    if (isSet(env.LLM_AUTH_TOKEN_URL)) {
      for (const k of OAUTH_REQUIRED_WHEN_TOKEN_URL_SET) {
        if (!isSet(env[k])) missing.push(k);
      }
    }
    if (missing.length) {
      throw new Error(`Missing required LLM secrets in env: ${missing.join(", ")}`);
    }
  }

  return {
    provider,
    apiBaseUrl: env.LLM_API_BASE_URL?.trim() || "https://api.anthropic.com/v1",
    apiKey: env.LLM_API_KEY ?? "",
    model: env.LLM_MODEL?.trim() || "claude-sonnet-4-6",
    maxCompletionTokens: parsePositiveInt(
      env.LLM_MAX_COMPLETION_TOKENS,
      4096,
      "LLM_MAX_COMPLETION_TOKENS",
    ),
    auth: {
      tokenUrl: env.LLM_AUTH_TOKEN_URL?.trim() || "",
      clientId: env.LLM_AUTH_CLIENT_ID ?? "",
      clientSecret: env.LLM_AUTH_CLIENT_SECRET ?? "",
      scope: env.LLM_AUTH_SCOPE?.trim() || "",
    },
  };
}
