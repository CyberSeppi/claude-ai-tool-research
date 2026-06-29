// Best-effort wrapper around @anthropic-ai/claude-agent-sdk.
//
// Requires the local `claude` CLI to be installed (Pro/Max subscription).
// NOT covered by automated tests — manual smoke only. Inside the Docker
// container this provider will fail at first call because the CLI is
// absent; that's the documented trade-off for using LLM_PROVIDER=cli.
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

      let fallback = "";
      for await (const message of query({
        prompt,
        options: {
          allowedTools: [],
          maxTurns: 1,
          systemPrompt: systemMsg?.content ?? DEFAULT_SYSTEM,
          ...(cfg.model ? { model: cfg.model } : {}),
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
