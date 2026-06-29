// OpenAI-compatible chat-completions provider. Posts to
// `{apiBaseUrl}/chat/completions` with x-apikey + (when an OAuth M2M
// gateway is configured) an Authorization: Bearer header. Buffered
// response only.
export function createApiProvider({ getConfig, oauth, fetchImpl = fetch }) {
  return {
    async chat(messages) {
      const cfg = getConfig();
      const token = await oauth.getAccessToken();
      const headers = {
        "x-apikey": cfg.apiKey,
        "Content-Type": "application/json",
      };
      if (token) headers["Authorization"] = `Bearer ${token}`;
      const res = await fetchImpl(`${cfg.apiBaseUrl}/chat/completions`, {
        method: "POST",
        headers,
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
