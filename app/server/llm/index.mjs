import { loadLlmConfig } from "./config.mjs";
import { createOAuthClient } from "./oauth.mjs";
import { createApiProvider } from "./provider-api.mjs";

// Single entry point for the chat backend. Reads env at construction
// time (so missing secrets fail fast at boot, not on first chat call).
// All dependencies are injectable for tests: env, fetchImpl, oauthFactory,
// providerFactory.
export function createLlmClient({
  env = process.env,
  fetchImpl = fetch,
  oauthFactory = createOAuthClient,
  providerFactory = createApiProvider,
} = {}) {
  const cfg = loadLlmConfig(env);
  const getConfig = () => cfg;
  const oauth = oauthFactory({ ...cfg.auth, fetchImpl });
  const provider = providerFactory({ getConfig, oauth, fetchImpl });
  return {
    chat: (messages) => provider.chat(messages),
    getConfig,
  };
}
