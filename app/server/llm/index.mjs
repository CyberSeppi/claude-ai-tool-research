import { loadLlmConfig } from "./config.mjs";
import { createOAuthClient } from "./oauth.mjs";
import { createApiProvider } from "./provider-api.mjs";
import { createCliProvider } from "./provider-cli.mjs";

const defaultFactories = {
  api: createApiProvider,
  cli: createCliProvider,
};

// Single entry point for the chat backend. Reads env at construction time
// (so missing secrets fail fast at boot, not on first chat call). For
// tests, all dependencies are injectable: env, fetchImpl, oauthFactory,
// and the provider factory map.
export function createLlmClient({
  env = process.env,
  fetchImpl = fetch,
  oauthFactory = createOAuthClient,
  providerFactories = defaultFactories,
} = {}) {
  const cfg = loadLlmConfig(env);
  const getConfig = () => cfg;

  let oauth = null;
  if (cfg.provider === "api") {
    oauth = oauthFactory({ ...cfg.auth, fetchImpl });
  }

  const make = providerFactories[cfg.provider];
  if (!make) throw new Error(`Unknown LLM provider: ${cfg.provider}`);
  const provider = make({ getConfig, oauth, fetchImpl });

  return {
    chat: (messages) => provider.chat(messages),
    getConfig,
  };
}
