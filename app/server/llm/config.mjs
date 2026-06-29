// LLM_API_KEY is always required when LLM_PROVIDER=api.
// LLM_AUTH_* are OPTIONAL — only validate them when the user has set
// LLM_AUTH_TOKEN_URL (signal that this endpoint uses OAuth M2M on top
// of the API key). Anthropic direct and OpenAI direct do NOT need them.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

// True when the file at credentialsPath contains a non-empty
// claudeAiOauth.accessToken — the Pro/Max OAuth login signal. Returns
// false on any read/parse failure so missing/unreadable files just fall
// through to the next auth mode.
function hasProMaxOAuth(credentialsPath) {
  try {
    const raw = readFileSync(credentialsPath, "utf8");
    const parsed = JSON.parse(raw);
    const token = parsed?.claudeAiOauth?.accessToken;
    return typeof token === "string" && token.trim() !== "";
  } catch {
    return false;
  }
}

// Resolve which Anthropic-compatible auth path the cli provider will use.
// Priority matches the SDK's own precedence — explicit env wins over mount.
function pickAuthMode(env, credentialsPath) {
  if (isSet(env.ANTHROPIC_API_KEY)) return "api-key";
  if (isSet(env.ANTHROPIC_AUTH_TOKEN)) return "oauth-token";
  if (hasProMaxOAuth(credentialsPath)) return "mount";
  return "none";
}

const CLI_AUTH_REMEDIES = [
  "  1. Set ANTHROPIC_API_KEY=sk-ant-... in .env (talks to api.anthropic.com)",
  "  2. Set ANTHROPIC_AUTH_TOKEN=<token> + ANTHROPIC_BASE_URL=<router-url> in .env",
  "  3. Run `claude /login` on the host (Pro/Max subscription required) so",
  "     ~/.claude/.credentials.json contains a claudeAiOauth.accessToken.",
  "Or switch to LLM_PROVIDER=api in .env to use the OpenAI-compatible path.",
];

export function loadLlmConfig(env = process.env, opts = {}) {
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

  // cli provider — resolve effective Anthropic credentials and refuse to
  // boot if nothing works. Better a clear boot-time error than a runtime
  // "Please run /login" coming out of the chat reply.
  const credentialsPath =
    opts.credentialsPath ?? join(env.HOME ?? homedir(), ".claude", ".credentials.json");
  const cliEffective = {
    baseUrl: env.ANTHROPIC_BASE_URL?.trim() || null,
    authToken: env.ANTHROPIC_AUTH_TOKEN?.trim() || null,
    apiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    mode: pickAuthMode(env, credentialsPath),
  };

  if (provider === "cli" && cliEffective.mode === "none") {
    throw new Error(
      `LLM_PROVIDER=cli but no usable Anthropic credentials were found.\n` +
        `Pick one of:\n` +
        CLI_AUTH_REMEDIES.join("\n"),
    );
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
    cliEffective,
  };
}
