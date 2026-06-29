// OpenAI-compatible chat-completions provider. Posts to
// `{apiBaseUrl}/chat/completions` with the OAuth bearer + an x-apikey
// header (BMW gateway requires both). Buffered response only.
export function createApiProvider({ getConfig, oauth, fetchImpl = fetch }) {
  return {
    async chat(messages) {
      const cfg = getConfig();
      const token = await oauth.getAccessToken();
      const res = await fetchImpl(`${cfg.apiBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "x-apikey": cfg.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          max_completion_tokens: cfg.maxCompletionTokens,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`LLM upstream failed: ${res.status} ${text.slice(0, 200)}`);
      }
      const parsed = await res.json();
      const content = parsed?.choices?.[0]?.message?.content;
      if (typeof content !== "string" || content.length === 0) {
        throw new Error("LLM upstream returned no content");
      }
      return content;
    },
  };
}
