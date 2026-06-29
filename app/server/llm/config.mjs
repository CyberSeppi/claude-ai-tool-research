const REQUIRED_API_SECRETS = ["LLM_API_KEY", "LLM_AUTH_CLIENT_ID", "LLM_AUTH_CLIENT_SECRET"];

function parsePositiveInt(raw, fallback, name) {
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== String(raw).trim()) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

export function loadLlmConfig(env = process.env) {
  const provider = (env.LLM_PROVIDER ?? "api").trim() || "api";
  if (provider !== "api" && provider !== "cli") {
    throw new Error(`LLM_PROVIDER must be 'api' or 'cli' (got '${provider}')`);
  }

  if (provider === "api") {
    const missing = REQUIRED_API_SECRETS.filter((k) => !env[k] || env[k].trim() === "");
    if (missing.length) {
      throw new Error(`Missing required LLM secrets in env: ${missing.join(", ")}`);
    }
  }

  return {
    provider,
    apiBaseUrl: env.LLM_API_BASE_URL?.trim() || "https://api.gcp.cloud.bmw/llmapi/v1",
    apiKey: env.LLM_API_KEY ?? "",
    model: env.LLM_MODEL?.trim() || "gpt-4o",
    maxCompletionTokens: parsePositiveInt(env.LLM_MAX_COMPLETION_TOKENS, 4096, "LLM_MAX_COMPLETION_TOKENS"),
    auth: {
      tokenUrl: env.LLM_AUTH_TOKEN_URL?.trim() || "https://auth.bmwgroup.net/auth/oauth2/realms/root/realms/machine2machine/access_token",
      clientId: env.LLM_AUTH_CLIENT_ID ?? "",
      clientSecret: env.LLM_AUTH_CLIENT_SECRET ?? "",
      scope: env.LLM_AUTH_SCOPE?.trim() || "machine2machine",
    },
  };
}
