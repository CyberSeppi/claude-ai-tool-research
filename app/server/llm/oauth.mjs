// M2M OAuth client_credentials token cache.
//
// Holds one (token, expiresAt) per instance. Refreshes 30s before
// expiry. Concurrent callers during a refresh share the in-flight
// promise so we don't hammer the auth endpoint.
//
// When tokenUrl is empty the upstream doesn't need OAuth on top of the
// API key (Anthropic direct, OpenAI direct). getAccessToken returns ""
// and the chat/embedding client just sends the API key in x-apikey.
const EXPIRY_BUFFER_MS = 30_000;

export function createOAuthClient({
  tokenUrl,
  clientId,
  clientSecret,
  scope,
  fetchImpl = fetch,
  now = () => Date.now(),
}) {
  if (!tokenUrl || tokenUrl.trim() === "") {
    return { getAccessToken: async () => "" };
  }
  let cached = null;
  let inFlight = null;

  async function fetchToken() {
    const body = new URLSearchParams({
      grant_type: "client_credentials",
      client_id: clientId,
      client_secret: clientSecret,
      scope,
    });
    const res = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`OAuth token request failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const j = await res.json();
    const expiresIn = Number(j.expires_in ?? 3600);
    cached = { token: j.access_token, expiresAt: now() + expiresIn * 1000 };
    return cached.token;
  }

  return {
    async getAccessToken() {
      if (cached && now() < cached.expiresAt - EXPIRY_BUFFER_MS) return cached.token;
      if (inFlight) return inFlight;
      inFlight = fetchToken().finally(() => {
        inFlight = null;
      });
      return inFlight;
    },
  };
}
