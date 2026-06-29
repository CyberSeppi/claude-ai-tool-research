// Batched embeddings client over OpenAI-compatible POST {baseUrl}/embeddings.
// Asserts dimension + unit-norm on the first non-empty response and caches
// the result so we don't pay the math on every call.
const UNIT_NORM_TOLERANCE = 1e-2;

export function createEmbeddingsClient({ getConfig, oauth, fetchImpl = fetch }) {
  let verified = false;

  async function embedBatch(inputs) {
    if (!inputs.length) return [];
    const cfg = getConfig();
    const token = await oauth.getAccessToken();
    const headers = {
      "x-apikey": cfg.apiKey,
      "Content-Type": "application/json",
    };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const res = await fetchImpl(`${cfg.apiBaseUrl}/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: cfg.model, input: inputs }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Embeddings upstream failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const parsed = await res.json();
    const data = parsed?.data;
    if (!Array.isArray(data) || data.length !== inputs.length) {
      throw new Error(
        `Embeddings upstream returned ${data?.length ?? 0} vectors for ${inputs.length} inputs`,
      );
    }
    // Sort by index — OpenAI returns sorted already, but defend against
    // gateways that reorder.
    const sorted = data.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = sorted.map((d) => Float32Array.from(d.embedding));
    if (!verified) {
      if (vectors[0].length !== cfg.dimensions) {
        throw new Error(
          `Embeddings dimension mismatch: expected ${cfg.dimensions} but got ${vectors[0].length}`,
        );
      }
      let sq = 0;
      for (const x of vectors[0]) sq += x * x;
      const norm = Math.sqrt(sq);
      if (norm < 1 - UNIT_NORM_TOLERANCE || norm > 1 + UNIT_NORM_TOLERANCE) {
        throw new Error(
          `Embeddings unit-norm check failed: expected ~1, got ${norm.toFixed(4)}`,
        );
      }
      verified = true;
    }
    return vectors;
  }

  return { embedBatch };
}
