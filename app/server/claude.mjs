import { query } from "@anthropic-ai/claude-agent-sdk";

export async function askClaude(prompt, opts = {}) {
  let fallback = "";
  for await (const message of query({
    prompt,
    options: {
      allowedTools: [],
      maxTurns: 1,
      systemPrompt: opts.system ?? "You are a concise, helpful research assistant. Answer only from the provided context.",
      ...(opts.model ? { model: opts.model } : {}),
    },
  })) {
    if (message.type === "result") {
      if (message.subtype === "success") return message.result;
      throw new Error(`Claude run failed: ${message.subtype}`);
    }
    if (message.type === "assistant") {
      for (const block of message.message.content) {
        if (block.type === "text") fallback += block.text;
      }
    }
  }
  return fallback;
}
