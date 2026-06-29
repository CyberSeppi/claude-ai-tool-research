// Best-effort wrapper around @anthropic-ai/claude-agent-sdk.
//
// Spawns the bundled `claude` CLI as a subprocess. The SDK reads its
// own auth from the subprocess environment + ~/.claude/. We pass an
// explicit env to the SDK so a stray ANTHROPIC_BASE_URL=http://x in the
// outer shell can't silently break the in-container resolution.
//
// NOT covered by automated tests — the SDK requires a real CLI binary.
// See app/server/llm/config.mjs for the boot-time pre-flight check
// that refuses to start when no Anthropic credentials are available.
import { query } from "@anthropic-ai/claude-agent-sdk";

const DEFAULT_SYSTEM =
  "You are a concise, helpful research assistant. Answer only from the provided context.";

export function createCliProvider({ getConfig }) {
  return {
    async chat(messages) {
      const cfg = getConfig();
      const systemMsg = messages.find((m) => m.role === "system");
      const rest = messages.filter((m) => m.role !== "system");
      const prompt = rest
        .map((m) => `${m.role.toUpperCase()}: ${m.content}`)
        .join("\n\n");

      // Build a clean subprocess env. Start from process.env so PATH /
      // HOME / locale inherit, then layer the exact Anthropic vars we
      // resolved at config-load time. This guarantees the CLI sees a
      // consistent auth setup regardless of the outer shell.
      const eff = cfg.cliEffective ?? {};
      const subprocessEnv = {
        ...process.env,
        CLAUDE_AGENT_SDK_CLIENT_APP: "claude-ai-tool-research/1.0",
      };
      if (eff.baseUrl) subprocessEnv.ANTHROPIC_BASE_URL = eff.baseUrl;
      // Clear conflicting auth vars before re-setting the one we want;
      // CLI warns when both API_KEY and AUTH_TOKEN are present.
      delete subprocessEnv.ANTHROPIC_API_KEY;
      delete subprocessEnv.ANTHROPIC_AUTH_TOKEN;
      if (eff.mode === "api-key" && eff.apiKey) {
        subprocessEnv.ANTHROPIC_API_KEY = eff.apiKey;
      } else if (eff.mode === "oauth-token" && eff.authToken) {
        subprocessEnv.ANTHROPIC_AUTH_TOKEN = eff.authToken;
      }
      // mode === 'mount' → no env auth, the CLI reads ~/.claude/.credentials.json.

      let fallback = "";
      for await (const message of query({
        prompt,
        options: {
          allowedTools: [],
          maxTurns: 1,
          systemPrompt: systemMsg?.content ?? DEFAULT_SYSTEM,
          ...(cfg.model ? { model: cfg.model } : {}),
          env: subprocessEnv,
        },
      })) {
        if (message.type === "result") {
          if (message.subtype === "success") return message.result;
          throw new Error(`Claude CLI run failed: ${message.subtype}`);
        }
        if (message.type === "assistant") {
          for (const block of message.message.content) {
            if (block.type === "text") fallback += block.text;
          }
        }
      }
      return fallback;
    },
  };
}
