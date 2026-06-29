# Design — Chat-Backend Refactor + RAG Layer

Date: 2026-06-29
Status: **Superseded for the `cli` provider** — the implementation
removed `LLM_PROVIDER=cli` entirely after we discovered that wiring a
Pro/Max subscription into a packaged app is a terms-of-service hazard.
The single supported chat path is now the OpenAI-compatible REST
provider documented in README.md. Pro/Max users route through a
local OpenAI↔Anthropic bridge of their choice (claude-bridge,
claude-code-router, LiteLLM) — the app sees only the bridge's
`/chat/completions` endpoint and stays vendor-neutral.

The rest of this spec (RAG, embeddings, fallback) remains accurate.

## Context

Today's chat path (`app/server/chat.mjs` + `claude.mjs`) calls the local
`claude` CLI through `@anthropic-ai/claude-agent-sdk`. The CLI is not
installed inside the Docker container (`node:24-slim`) → the in-container
chat is broken. For `scope=global` the prompt also stuffs all 143 records
into the model — fine at this size, but no real retrieval is happening.

This spec covers two changes:

1. **Provider-pluggable chat backend.** A generic OpenAI-compatible HTTP
   client becomes the default (`LLM_PROVIDER=api`), wired against the
   BMW GenAI M2M gateway (the same credentials `ops-ai-cockpit` uses).
   The existing CLI path stays as `LLM_PROVIDER=cli` for free local dev.
2. **RAG via embeddings.** Each record is embedded at boot (fields + the
   repo's README split into heading-aware chunks). `scope=global` chat
   retrieves the top-K most similar chunks and feeds only those records
   to the LLM. `scope=record` and `scope=selection` stay explicit.

## Non-goals (out of V1)

- SSE streaming. Frontend already does `await api.chat()` and renders the
  finished answer; buffered responses keep frontend untouched.
- Re-embedding READMEs when remote repos change. READMEs are quasi-static;
  bump `EMBEDDINGS_PROMPT_VERSION` to invalidate.
- A second embedding provider (Voyage AI) in code — the architecture is
  provider-pluggable but only OpenAI-compat ships in V1.
- sqlite-vec / pgvector. ~1000–1300 vectors total, brute-force JS cosine
  runs in well under 10 ms.
- Multi-model fan-out, retrieval-result caching, or any UI changes beyond
  an optional debug badge.

## Architecture

```
app/server/
├── llm/
│   ├── index.mjs          createLlmClient() — picks provider via LLM_PROVIDER
│   ├── config.mjs         loadLlmConfig(env) → typed; throws on missing secrets
│   ├── oauth.mjs          M2M token cache, in-memory, TTL refresh
│   ├── provider-api.mjs   POST {BASE}/chat/completions, OpenAI-compat
│   ├── provider-cli.mjs   wraps @anthropic-ai/claude-agent-sdk (current path)
│   └── *.test.mjs         mocked fetch
├── embeddings/
│   ├── config.mjs         loadEmbeddingsConfig(env) → typed
│   ├── client.mjs         embedBatch(texts) → Float32Array[]
│   ├── readme.mjs         fetchReadme(repo) + heading-aware markdown chunker
│   ├── store.mjs          SQLite reads/writes for embedded_chunks
│   ├── backfill.mjs       runBackfill(records) — boot-time, idempotent
│   ├── retrieve.mjs       topK(query, k) → ranked Record[]
│   └── *.test.mjs
└── chat.mjs               buildChatContext() — global-scope uses retrieve()
```

### Component boundaries

- **`llm/`** — knows nothing about records, prompts, or RAG. Input: a
  list of `LlmMessage`. Output: a string (V1 is buffered, the public
  signature stays `chat(messages) → Promise<string>` so a future SSE
  variant can swap in without touching callers).
- **`embeddings/`** — knows nothing about chat. Input: text. Output:
  vectors + top-K retrieval. `chat.mjs` is the only consumer.
- **`chat.mjs`** — the orchestrator. Owns the prompt-stuffing rules per
  scope, and switches RAG on/off based on `EMBEDDINGS_ENABLED` and the
  store being non-empty.

### Configuration

All knobs come from `.env` (gitignored) / `.env.example` (committed).
Secrets are required; endpoints + tuning have sensible defaults.

Required:
- `LLM_API_KEY`, `LLM_AUTH_CLIENT_ID`, `LLM_AUTH_CLIENT_SECRET`
- `EMBEDDINGS_API_KEY`, `EMBEDDINGS_AUTH_CLIENT_ID`, `EMBEDDINGS_AUTH_CLIENT_SECRET`
- `GITHUB_TOKEN` (read-only PAT for the README fetch)

Optional / has defaults:
- `LLM_PROVIDER` (`api` default | `cli`)
- `LLM_API_BASE_URL`, `LLM_AUTH_TOKEN_URL`, `LLM_AUTH_SCOPE`, `LLM_MODEL`, `LLM_MAX_COMPLETION_TOKENS`
- `EMBEDDINGS_ENABLED` (true by default)
- `EMBEDDINGS_API_BASE_URL`, `EMBEDDINGS_AUTH_TOKEN_URL`, `EMBEDDINGS_AUTH_SCOPE`, `EMBEDDINGS_MODEL`, `EMBEDDINGS_DIMENSIONS`
- `EMBEDDINGS_BACKFILL_ON_STARTUP` (true)
- `EMBEDDINGS_PROMPT_VERSION` (1) — bump to invalidate all stored vectors
- `EMBEDDINGS_BATCH_SIZE` (32)
- `EMBEDDINGS_CHUNK_MAX_CHARS` (1500)
- `EMBEDDINGS_RETRIEVAL_TOP_K` (8)
- `EMBEDDINGS_RETRIEVAL_MIN_SCORE` (0.0 — disabled by default; raise to e.g. 0.3 to suppress weak hits when the index is small)

`config.mjs` modules read env at every call (lazy) so docker `--env-file`
edits take effect on the next request without rebuild.

### OAuth caching

The BMW M2M gateway issues access tokens with ~1 h expiry. Each backend
process keeps one cache entry per `(authTokenUrl, clientId, scope)` tuple:

- First call → POST to `{authTokenUrl}` with form-encoded `client_credentials`
  grant, store `{token, expiresAt}`.
- Subsequent calls → return cached token if `now < expiresAt − 30 s`.
- Refresh coalesced: parallel callers during a refresh share one in-flight
  promise so we don't issue N simultaneous token requests.

The same cache key is shared by LLM and embeddings calls when the
`(tokenUrl, clientId, scope)` tuple matches (it does for BMW GenAI).

### Embed source format (per record)

Two chunk types share the `embedded_chunks` table:

1. **`fields` chunk** (always exactly one per record):
   ```
   {name}
   {category} · {use_cases joined with ", "}

   {description}

   Efficiency gain: {efficiency_gain}
   ```
2. **`readme` chunks** (zero or many per record):
   - Fetch `https://api.github.com/repos/{owner}/{repo}/readme` with
     `Authorization: Bearer ${GITHUB_TOKEN}`, `Accept: application/vnd.github.raw`.
   - Markdown-aware split on `##` and `###`. If a section exceeds
     `EMBEDDINGS_CHUNK_MAX_CHARS` (1500), char-split with 200-char
     overlap as fallback.
   - Each chunk's embedded text is prefixed with its heading path:
     ```
     {repo_name}: {h1 || repo_name} > {h2} > {h3}

     {section body, trimmed}
     ```
   - Repo name in the prefix ensures lexical "qdrant/mcp-server-qdrant"
     queries still hit chunks of README sub-sections.
   - On any fetch failure (404, 401, rate limit, network) log a warning
     and proceed with just the `fields` chunk for that record.

### Storage schema

```sql
CREATE TABLE IF NOT EXISTS embedded_chunks (
  record_id      TEXT NOT NULL,
  chunk_index    INTEGER NOT NULL,
  source         TEXT NOT NULL CHECK (source IN ('fields', 'readme')),
  heading_path   TEXT,
  text           TEXT NOT NULL,
  text_hash      TEXT NOT NULL,
  model          TEXT NOT NULL,
  vector         BLOB NOT NULL,
  prompt_version INTEGER NOT NULL DEFAULT 1,
  embedded_at    TEXT NOT NULL,
  PRIMARY KEY (record_id, chunk_index, model, prompt_version)
);
CREATE INDEX IF NOT EXISTS idx_chunks_text_hash ON embedded_chunks(text_hash);
```

- `vector` holds the raw Float32Array bytes (`buf.buffer` slice, 3072 × 4 =
  12 288 bytes per row at the default dim). Read back with
  `new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)`.
- `text_hash = sha256(text)` is the idempotency gate — if the same text
  is already stored under the same `(model, prompt_version)`, skip the
  embed call entirely.
- Same DB file as `flags` (`app/db/flags.json` becomes `app/db/app.sqlite`
  in this change, see Migration below).

### Backfill flow (boot)

```js
// app/server/index.mjs (boot)
await runBackfill({ records, ...embeddingsCfg, store, client })
serve(...)
```

`runBackfill`:
1. Build the candidate chunk list: 1 `fields` chunk per record + N
   `readme` chunks (gated by `GITHUB_TOKEN` presence).
2. For each candidate, compute `text_hash`; skip those already in
   `embedded_chunks` for the current `(model, prompt_version)`.
3. Batch the survivors in groups of `EMBEDDINGS_BATCH_SIZE` (32) and
   call `client.embedBatch(...)`.
4. Insert results, log progress per batch, never crash boot on per-chunk
   failures — log + skip.

Container blocks on this before binding port 8787. Re-runs are cheap
because the hash gate makes everything no-op once warm.

### Retrieval flow (per chat call, scope=global)

```js
// app/server/embeddings/retrieve.mjs
async topK(query, k) {
  const [qVec] = await client.embedBatch([query])     // cached 5 min per sha256(query)
  const rows = store.allChunks()                       // <2k rows, returned with vectors
  const scored = rows.map(r => ({ r, sim: cosine(qVec, r.vector) }))
                     .filter(s => s.sim >= cfg.minScore)
                     .sort((a, b) => b.sim - a.sim)
  // collapse to records: best-chunk score per record_id
  const seen = new Set(); const out = []
  for (const s of scored) {
    if (seen.has(s.r.record_id)) continue
    seen.add(s.r.record_id); out.push({ record_id: s.r.record_id, score: s.sim, chunk: s.r })
    if (out.length === k) break
  }
  return out
}
```

`chat.mjs` then loads the full records for those IDs from the existing
`loadReport(...)` result and renders them with the current
`recordDetail()` formatter.

### Fallback when RAG is unavailable

`chat.mjs` decides per call:

```js
const useRag = scope === 'global' &&
               embeddingsCfg.enabled &&
               store.count() > 0
```

If false → reuse today's `buildChatContext('global', allRecords)`. The
response carries `retrieval.mode = 'rag' | 'full-context'` so future
debug UI can show which path served the answer.

### Error UX

| Case | Backend | Frontend |
|---|---|---|
| Required env var missing | refuse to start, log all missing keys | — |
| OAuth token call fails | `502 { error: 'auth gateway failed' }` | red error line in `ChatBox` |
| `/chat/completions` 5xx | `502` with upstream status text | red error line |
| GitHub README fetch fails | log.warn, fields-chunk only | — (backfill continues) |
| Embeddings disabled / empty index | `retrieval.mode = 'full-context'` | optional debug badge |
| GitHub PAT 401 | log.warn, skip all README chunks for run | — |

### Tests

- `llm/provider-api.test.mjs` — mocked fetch: header set, OAuth bearer
  attached, body shape, response parsing, non-2xx → `ExternalApiError`.
- `llm/oauth.test.mjs` — TTL refresh, expiry-buffer, concurrent-call
  coalescing, refresh failure surfaces.
- `embeddings/client.test.mjs` — dimension assertion, unit-norm assertion,
  batch input/output ordering preserved.
- `embeddings/readme.test.mjs` — markdown-split rules, heading-path
  composition, char-split fallback, fixtures for typical READMEs.
- `embeddings/store.test.mjs` — schema migrations idempotent, text_hash
  gate, cosine math, top-K ordering, prompt_version invalidation.
- `embeddings/backfill.test.mjs` — skips warm chunks, batch boundaries,
  fetch-failure isolation.
- `chat.test.mjs` — global-scope picks `rag` when enabled+warm, picks
  `full-context` otherwise; record/selection unaffected.
- CLI provider has **no** tests (best-effort path, manual smoke only).

OAuth/LLM/embedding tests use a fake `fetchImpl` injected through the
existing `*ClientDeps` pattern. No live BMW calls in CI.

## Migration concerns

- **DB file location.** Today `app/server/flags.mjs` writes a JSON file
  at `${DB_DIR}/flags.json`. The new embedded_chunks table needs SQLite.
  V1 keeps `flags.json` as-is and introduces a separate
  `${DB_DIR}/embeddings.sqlite` so the existing flag store doesn't need
  migrating. (A future cleanup can fold both into one DB.)
- **Container env.** `run.sh` already sets the per-user mounts; it must
  also pass `--env-file ${ROOT}/.env` so the secrets reach the container.

## Open follow-ups (not blocking V1)

- Add a `/api/embeddings/status` endpoint (record count, chunk count,
  model, prompt_version, last backfill) so the UI can show readiness.
- Add `retrieval.scores` to the chat response (already in design above)
  + frontend badge — small future PR.
- README hot-reload when `report.json` is regenerated (`/api/refresh`
  could call `runBackfill` again).
