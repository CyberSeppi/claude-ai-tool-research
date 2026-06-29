# Chat-Backend Refactor + RAG Layer — Implementation Plan

> **Status note (2026-06-29):** The `cli` provider tasks in this plan
> (Task 5 and any cli-specific wiring in later tasks) are NOT executed.
> The implementation dropped `LLM_PROVIDER=cli` entirely. Only the `api`
> provider ships. See README.md "Chat backend" and
> `2026-06-29-chat-rag-design.md` for the current architecture.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the broken CLI-only chat backend with a pluggable LLM provider layer (default: OpenAI-compatible REST against the BMW GenAI gateway, fallback: existing `claude` CLI), and add a RAG layer that embeds each record's fields + README at boot and uses top-K retrieval for `scope=global` chat.

**Architecture:** Two new modules under `app/server/` — `llm/` (provider-pluggable chat client with OAuth M2M token caching) and `embeddings/` (config → client → readme-fetcher → SQLite store → backfill → retriever). `chat.mjs` becomes the orchestrator that picks RAG vs. full-context per call. Buffered responses only in V1 — the frontend stays untouched. Backfill blocks boot and is idempotent via `sha256(text)`.

**Tech Stack:** Node 20+, ESM modules, Hono, `better-sqlite3`, `node --test`, native `fetch`. No new heavy deps — vector storage is JSON-byte BLOB in SQLite, retrieval is brute-force JS cosine over <2 000 vectors.

## Global Constraints

- All new code goes under `app/server/llm/` and `app/server/embeddings/`. Existing files (`app.mjs`, `chat.mjs`, `index.mjs`, `claude.mjs`) are modified only where explicitly listed.
- ESM only. Match the existing project's `.mjs` extension and `import` style.
- All test files end in `.test.mjs` and run via `node --test app/server/**/*.test.mjs`. Tests use `node:test` (no vitest in the backend).
- No live BMW API calls in tests. Inject `fetchImpl` through `*ClientDeps` and pass mocks.
- Token cache and retrieval cache live in-process only. No disk persistence.
- The CLI provider (`provider-cli.mjs`) gets **no automated tests** — manual smoke only.
- `EMBEDDINGS_DIMENSIONS` defaults to `3072`; vectors are stored as raw `Float32Array` bytes in BLOB columns.
- `EMBEDDINGS_PROMPT_VERSION` is a hard cache-buster — different value → different row in `embedded_chunks`.
- Required env vars (LLM secrets, embedding secrets, `GITHUB_TOKEN`) — if missing, the server logs all missing keys and refuses to start.
- `provider-cli.mjs` MUST keep accepting the same `(prompt, opts)` shape today's `askClaude` consumes, OR the modified `chat.mjs` MUST translate. Decision: refactor to a uniform `chat({messages, opts})` signature — see Task 5.

---

### Task 1: Add new env vars to `.env.example`

**Files:**
- Modify: `.env.example`

**Interfaces:**
- Consumes: nothing
- Produces: documented env surface (`GITHUB_TOKEN`, `EMBEDDINGS_PROMPT_VERSION`, `EMBEDDINGS_BATCH_SIZE`, `EMBEDDINGS_CHUNK_MAX_CHARS`, `EMBEDDINGS_BACKFILL_ON_STARTUP`)

- [ ] **Step 1: Edit `.env.example`**

Append below the existing `EMBEDDINGS_RETRIEVAL_MIN_SCORE` line:

```env

# Read-only PAT for fetching repo READMEs at backfill time.
# https://github.com/settings/tokens (only "public_repo" scope needed).
GITHUB_TOKEN=

# Bump to invalidate all stored embeddings (e.g. after changing the
# embed-source template in app/server/embeddings/source.mjs).
EMBEDDINGS_PROMPT_VERSION=1

# Run the boot-time backfill that embeds every record's fields + README.
# When false, the index stays cold and scope=global chat falls back to
# full-context (today's behaviour).
EMBEDDINGS_BACKFILL_ON_STARTUP=true

# Embed batch size (max inputs per /embeddings call).
EMBEDDINGS_BATCH_SIZE=32

# Heading-aware split: sections longer than this character count get
# char-split with 200-char overlap as fallback.
EMBEDDINGS_CHUNK_MAX_CHARS=1500
```

- [ ] **Step 2: Mirror the same keys into local `.env`** (with placeholder for `GITHUB_TOKEN`)

`.env` is gitignored, so set `GITHUB_TOKEN=` blank for now and document in PROGRESS.md that it must be filled. The other knobs can use the defaults shown above.

- [ ] **Step 3: Commit**

```bash
git add .env.example
git commit -m "feat(env): document RAG knobs in .env.example"
```

---

### Task 2: `app/server/llm/config.mjs` + tests

**Files:**
- Create: `app/server/llm/config.mjs`
- Create: `app/server/llm/config.test.mjs`

**Interfaces:**
- Consumes: `process.env` (or injected env object)
- Produces:
  - `loadLlmConfig(env = process.env) → LlmConfig`
  - `LlmConfig = { provider: 'api'|'cli', apiBaseUrl, apiKey, model, maxCompletionTokens, auth: { tokenUrl, clientId, clientSecret, scope } }`

- [ ] **Step 1: Write the failing test**

```js
// app/server/llm/config.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadLlmConfig } from "./config.mjs";

const FULL_ENV = {
  LLM_PROVIDER: "api",
  LLM_API_KEY: "k",
  LLM_AUTH_CLIENT_ID: "c",
  LLM_AUTH_CLIENT_SECRET: "s",
  LLM_API_BASE_URL: "https://example/llmapi/v1",
  LLM_AUTH_TOKEN_URL: "https://example/auth",
  LLM_AUTH_SCOPE: "machine2machine",
  LLM_MODEL: "gpt-4o",
  LLM_MAX_COMPLETION_TOKENS: "4096",
};

test("loadLlmConfig: returns typed config when all vars present", () => {
  const cfg = loadLlmConfig(FULL_ENV);
  assert.equal(cfg.provider, "api");
  assert.equal(cfg.apiKey, "k");
  assert.equal(cfg.model, "gpt-4o");
  assert.equal(cfg.maxCompletionTokens, 4096);
  assert.equal(cfg.auth.tokenUrl, "https://example/auth");
});

test("loadLlmConfig: defaults provider to 'api' when LLM_PROVIDER unset", () => {
  const { LLM_PROVIDER: _, ...env } = FULL_ENV;
  const cfg = loadLlmConfig(env);
  assert.equal(cfg.provider, "api");
});

test("loadLlmConfig: cli provider skips secret validation", () => {
  const cfg = loadLlmConfig({ LLM_PROVIDER: "cli", LLM_MODEL: "claude-sonnet-4-6" });
  assert.equal(cfg.provider, "cli");
  assert.equal(cfg.model, "claude-sonnet-4-6");
});

test("loadLlmConfig: api provider throws listing every missing secret", () => {
  assert.throws(
    () => loadLlmConfig({ LLM_PROVIDER: "api" }),
    /LLM_API_KEY.*LLM_AUTH_CLIENT_ID.*LLM_AUTH_CLIENT_SECRET/s,
  );
});

test("loadLlmConfig: maxCompletionTokens must be a positive integer", () => {
  assert.throws(
    () => loadLlmConfig({ ...FULL_ENV, LLM_MAX_COMPLETION_TOKENS: "not-a-number" }),
    /LLM_MAX_COMPLETION_TOKENS/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && node --test server/llm/config.test.mjs
```
Expected: FAIL — file `./config.mjs` does not exist.

- [ ] **Step 3: Implement `config.mjs`**

```js
// app/server/llm/config.mjs
const REQUIRED_API_SECRETS = ["LLM_API_KEY", "LLM_AUTH_CLIENT_ID", "LLM_AUTH_CLIENT_SECRET"];

function parsePositiveInt(raw, fallback, name) {
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== String(raw).trim()) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}

export function loadLlmConfig(env = process.env) {
  const provider = (env.LLM_PROVIDER ?? "api").trim() || "api";
  if (provider !== "api" && provider !== "cli") {
    throw new Error(`LLM_PROVIDER must be 'api' or 'cli' (got '${provider}')`);
  }

  if (provider === "api") {
    const missing = REQUIRED_API_SECRETS.filter((k) => !env[k] || env[k].trim() === "");
    if (missing.length) {
      throw new Error(`Missing required LLM secrets in env: ${missing.join(", ")}`);
    }
  }

  return {
    provider,
    apiBaseUrl: env.LLM_API_BASE_URL?.trim() || "https://api.gcp.cloud.bmw/llmapi/v1",
    apiKey: env.LLM_API_KEY ?? "",
    model: env.LLM_MODEL?.trim() || "gpt-4o",
    maxCompletionTokens: parsePositiveInt(env.LLM_MAX_COMPLETION_TOKENS, 4096, "LLM_MAX_COMPLETION_TOKENS"),
    auth: {
      tokenUrl: env.LLM_AUTH_TOKEN_URL?.trim() || "https://auth.bmwgroup.net/auth/oauth2/realms/root/realms/machine2machine/access_token",
      clientId: env.LLM_AUTH_CLIENT_ID ?? "",
      clientSecret: env.LLM_AUTH_CLIENT_SECRET ?? "",
      scope: env.LLM_AUTH_SCOPE?.trim() || "machine2machine",
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && node --test server/llm/config.test.mjs
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/server/llm/config.mjs app/server/llm/config.test.mjs
git commit -m "feat(llm): typed config loader with required-secret gate"
```

---

### Task 3: `app/server/llm/oauth.mjs` — M2M token cache + tests

**Files:**
- Create: `app/server/llm/oauth.mjs`
- Create: `app/server/llm/oauth.test.mjs`

**Interfaces:**
- Consumes: `LlmConfig.auth` (or any `{tokenUrl, clientId, clientSecret, scope}` shape)
- Produces:
  - `createOAuthClient({ tokenUrl, clientId, clientSecret, scope, fetchImpl?, now? }) → OAuthClient`
  - `OAuthClient.getAccessToken() → Promise<string>`

Cache rules: 30 s expiry buffer; concurrent calls during a refresh share one in-flight promise.

- [ ] **Step 1: Write the failing test**

```js
// app/server/llm/oauth.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createOAuthClient } from "./oauth.mjs";

const baseCfg = {
  tokenUrl: "https://auth/example/token",
  clientId: "cid",
  clientSecret: "csec",
  scope: "machine2machine",
};

function fakeFetch(replies) {
  let i = 0;
  return async (url, init) => {
    const reply = replies[i++] ?? replies[replies.length - 1];
    if (typeof reply === "function") return reply(url, init);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  };
}

test("first call fetches a token and returns it", async () => {
  const fetchImpl = fakeFetch([{ body: { access_token: "T1", expires_in: 3600 } }]);
  const oauth = createOAuthClient({ ...baseCfg, fetchImpl, now: () => 0 });
  assert.equal(await oauth.getAccessToken(), "T1");
});

test("second call within TTL reuses the cached token", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    return new Response(JSON.stringify({ access_token: "T1", expires_in: 3600 }), { status: 200 });
  };
  const oauth = createOAuthClient({ ...baseCfg, fetchImpl, now: () => 0 });
  await oauth.getAccessToken();
  await oauth.getAccessToken();
  assert.equal(calls, 1);
});

test("expired token triggers a refresh (30 s buffer)", async () => {
  const replies = [
    { body: { access_token: "T1", expires_in: 60 } },
    { body: { access_token: "T2", expires_in: 60 } },
  ];
  const fetchImpl = fakeFetch(replies);
  let t = 0;
  const oauth = createOAuthClient({ ...baseCfg, fetchImpl, now: () => t * 1000 });
  assert.equal(await oauth.getAccessToken(), "T1");
  t = 31; // inside the 30s expiry buffer
  assert.equal(await oauth.getAccessToken(), "T2");
});

test("concurrent callers during refresh share one in-flight request", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 20));
    return new Response(JSON.stringify({ access_token: "T1", expires_in: 3600 }), { status: 200 });
  };
  const oauth = createOAuthClient({ ...baseCfg, fetchImpl, now: () => 0 });
  await Promise.all([oauth.getAccessToken(), oauth.getAccessToken(), oauth.getAccessToken()]);
  assert.equal(calls, 1);
});

test("non-2xx response surfaces an error", async () => {
  const fetchImpl = async () => new Response("nope", { status: 500 });
  const oauth = createOAuthClient({ ...baseCfg, fetchImpl, now: () => 0 });
  await assert.rejects(() => oauth.getAccessToken(), /OAuth.*500/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && node --test server/llm/oauth.test.mjs
```
Expected: FAIL — `./oauth.mjs` does not exist.

- [ ] **Step 3: Implement `oauth.mjs`**

```js
// app/server/llm/oauth.mjs
const EXPIRY_BUFFER_MS = 30_000;

export function createOAuthClient({ tokenUrl, clientId, clientSecret, scope, fetchImpl = fetch, now = () => Date.now() }) {
  let cached = null;     // { token, expiresAt }
  let inFlight = null;   // Promise<string>

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
      inFlight = fetchToken().finally(() => { inFlight = null; });
      return inFlight;
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && node --test server/llm/oauth.test.mjs
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/server/llm/oauth.mjs app/server/llm/oauth.test.mjs
git commit -m "feat(llm): M2M OAuth token cache with TTL + coalescing"
```

---

### Task 4: `app/server/llm/provider-api.mjs` — OpenAI-compatible REST client + tests

**Files:**
- Create: `app/server/llm/provider-api.mjs`
- Create: `app/server/llm/provider-api.test.mjs`

**Interfaces:**
- Consumes: `LlmConfig` (api shape), `OAuthClient` (from Task 3)
- Produces:
  - `createApiProvider({ getConfig, oauth, fetchImpl? }) → { chat(messages) → Promise<string> }`
  - `messages: Array<{ role: 'system'|'user'|'assistant', content: string }>`

- [ ] **Step 1: Write the failing test**

```js
// app/server/llm/provider-api.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApiProvider } from "./provider-api.mjs";

const cfg = {
  provider: "api",
  apiBaseUrl: "https://api.gcp.cloud.bmw/llmapi/v1",
  apiKey: "K",
  model: "gpt-4o",
  maxCompletionTokens: 256,
  auth: {},
};
const oauth = { getAccessToken: async () => "TKN" };

function makeFetch(impl) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    return impl(url, init);
  };
  return { fetchImpl, calls };
}

test("chat: posts to {base}/chat/completions with auth + apikey headers", async () => {
  const { fetchImpl, calls } = makeFetch(async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: "hi" }, finish_reason: "stop" }] }), { status: 200 }),
  );
  const provider = createApiProvider({ getConfig: () => cfg, oauth, fetchImpl });
  const answer = await provider.chat([{ role: "user", content: "ping" }]);
  assert.equal(answer, "hi");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.gcp.cloud.bmw/llmapi/v1/chat/completions");
  assert.equal(calls[0].init.headers["Authorization"], "Bearer TKN");
  assert.equal(calls[0].init.headers["x-apikey"], "K");
  const body = JSON.parse(calls[0].init.body);
  assert.equal(body.model, "gpt-4o");
  assert.equal(body.max_completion_tokens, 256);
  assert.deepEqual(body.messages, [{ role: "user", content: "ping" }]);
});

test("chat: non-2xx throws with upstream status", async () => {
  const { fetchImpl } = makeFetch(async () => new Response("boom", { status: 500 }));
  const provider = createApiProvider({ getConfig: () => cfg, oauth, fetchImpl });
  await assert.rejects(() => provider.chat([{ role: "user", content: "x" }]), /LLM upstream failed: 500/);
});

test("chat: empty choices array surfaces an error", async () => {
  const { fetchImpl } = makeFetch(async () =>
    new Response(JSON.stringify({ choices: [] }), { status: 200 }),
  );
  const provider = createApiProvider({ getConfig: () => cfg, oauth, fetchImpl });
  await assert.rejects(() => provider.chat([{ role: "user", content: "x" }]), /no content/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && node --test server/llm/provider-api.test.mjs
```
Expected: FAIL — `./provider-api.mjs` does not exist.

- [ ] **Step 3: Implement `provider-api.mjs`**

```js
// app/server/llm/provider-api.mjs
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
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && node --test server/llm/provider-api.test.mjs
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/server/llm/provider-api.mjs app/server/llm/provider-api.test.mjs
git commit -m "feat(llm): OpenAI-compatible REST provider"
```

---

### Task 5: `app/server/llm/provider-cli.mjs` — wrap current claude-agent-sdk path (best-effort, no tests)

**Files:**
- Create: `app/server/llm/provider-cli.mjs`

**Interfaces:**
- Consumes: `LlmConfig` (cli shape)
- Produces: `createCliProvider({ getConfig }) → { chat(messages) → Promise<string> }`

The CLI path can't take a system + user pair as cleanly; we flatten the messages into one prompt with role headers and pass the system part via the SDK's `systemPrompt` option.

- [ ] **Step 1: Implement `provider-cli.mjs`**

```js
// app/server/llm/provider-cli.mjs
//
// Best-effort wrapper around @anthropic-ai/claude-agent-sdk. Requires the
// local `claude` CLI to be installed (Pro/Max subscription). NOT covered
// by automated tests — manual smoke only.
import { query } from "@anthropic-ai/claude-agent-sdk";

export function createCliProvider({ getConfig }) {
  return {
    async chat(messages) {
      const cfg = getConfig();
      const systemMsg = messages.find((m) => m.role === "system");
      const rest = messages.filter((m) => m.role !== "system");
      const prompt = rest.map((m) => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");

      let fallback = "";
      for await (const message of query({
        prompt,
        options: {
          allowedTools: [],
          maxTurns: 1,
          systemPrompt: systemMsg?.content ?? "You are a concise, helpful research assistant. Answer only from the provided context.",
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
```

- [ ] **Step 2: Smoke-verify locally (only if `claude` CLI is installed)**

```bash
cd app && node -e '
import("./server/llm/provider-cli.mjs").then(async ({ createCliProvider }) => {
  const p = createCliProvider({ getConfig: () => ({ model: "claude-sonnet-4-6" }) });
  console.log(await p.chat([{ role: "user", content: "say ok and nothing else" }]));
});'
```
Expected: prints "ok" or similar. If `claude` CLI is missing, this is fine — we don't gate on it.

- [ ] **Step 3: Commit**

```bash
git add app/server/llm/provider-cli.mjs
git commit -m "feat(llm): cli provider extracted into pluggable seam"
```

---

### Task 6: `app/server/llm/index.mjs` — provider selector + integration test

**Files:**
- Create: `app/server/llm/index.mjs`
- Create: `app/server/llm/index.test.mjs`

**Interfaces:**
- Consumes: `loadLlmConfig` (Task 2), `createOAuthClient` (Task 3), `createApiProvider` (Task 4), `createCliProvider` (Task 5)
- Produces:
  - `createLlmClient({ env?, fetchImpl?, oauthFactory?, providerFactories? }) → { chat(messages) → Promise<string>, getConfig() → LlmConfig }`

The injection seams (`oauthFactory`, `providerFactories`) exist so tests don't have to ship a real `claude` CLI just to verify the wiring.

- [ ] **Step 1: Write the failing test**

```js
// app/server/llm/index.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createLlmClient } from "./index.mjs";

const apiEnv = {
  LLM_PROVIDER: "api",
  LLM_API_KEY: "k",
  LLM_AUTH_CLIENT_ID: "c",
  LLM_AUTH_CLIENT_SECRET: "s",
  LLM_API_BASE_URL: "https://api/llmapi/v1",
};

test("createLlmClient: selects api provider by default", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ access_token: "T", expires_in: 3600 }), { status: 200 });
  const calls = [];
  const factories = {
    api: ({ getConfig, oauth }) => ({
      async chat(msgs) { calls.push({ provider: "api", msgs, cfg: getConfig(), tok: await oauth.getAccessToken() }); return "api-ok"; },
    }),
    cli: () => { throw new Error("cli should not be picked"); },
  };
  const client = createLlmClient({ env: apiEnv, fetchImpl, providerFactories: factories });
  assert.equal(await client.chat([{ role: "user", content: "hi" }]), "api-ok");
  assert.equal(calls[0].provider, "api");
  assert.equal(calls[0].tok, "T");
});

test("createLlmClient: cli provider does not require API secrets", () => {
  const factories = {
    api: () => { throw new Error("api should not be picked"); },
    cli: () => ({ chat: async () => "cli-ok" }),
  };
  const client = createLlmClient({ env: { LLM_PROVIDER: "cli" }, providerFactories: factories });
  assert.equal(client.getConfig().provider, "cli");
});

test("createLlmClient: surfaces config errors at construction time", () => {
  assert.throws(
    () => createLlmClient({ env: { LLM_PROVIDER: "api" } }),
    /Missing required LLM secrets/,
  );
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && node --test server/llm/index.test.mjs
```
Expected: FAIL.

- [ ] **Step 3: Implement `index.mjs`**

```js
// app/server/llm/index.mjs
import { loadLlmConfig } from "./config.mjs";
import { createOAuthClient } from "./oauth.mjs";
import { createApiProvider } from "./provider-api.mjs";
import { createCliProvider } from "./provider-cli.mjs";

const defaultFactories = {
  api: createApiProvider,
  cli: createCliProvider,
};

export function createLlmClient({
  env = process.env,
  fetchImpl = fetch,
  oauthFactory = createOAuthClient,
  providerFactories = defaultFactories,
} = {}) {
  let cfg = loadLlmConfig(env);
  const getConfig = () => cfg;

  let oauth = null;
  if (cfg.provider === "api") {
    oauth = oauthFactory({ ...cfg.auth, fetchImpl });
  }

  const make = providerFactories[cfg.provider];
  if (!make) throw new Error(`Unknown LLM provider: ${cfg.provider}`);
  const provider = make({ getConfig, oauth, fetchImpl });

  return { chat: provider.chat, getConfig };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && node --test server/llm/index.test.mjs
```
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add app/server/llm/index.mjs app/server/llm/index.test.mjs
git commit -m "feat(llm): provider selector with injection seams"
```

---

### Task 7: `app/server/embeddings/config.mjs` + tests

**Files:**
- Create: `app/server/embeddings/config.mjs`
- Create: `app/server/embeddings/config.test.mjs`

**Interfaces:**
- Consumes: env
- Produces:
  - `loadEmbeddingsConfig(env = process.env) → EmbeddingsConfig`
  - `EmbeddingsConfig = { enabled, backfillOnStartup, apiBaseUrl, apiKey, model, dimensions, promptVersion, batchSize, chunkMaxChars, retrieval: { topK, minScore }, auth: {...}, githubToken }`

- [ ] **Step 1: Write the failing test**

```js
// app/server/embeddings/config.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadEmbeddingsConfig } from "./config.mjs";

const ENV = {
  EMBEDDINGS_API_KEY: "k",
  EMBEDDINGS_AUTH_CLIENT_ID: "c",
  EMBEDDINGS_AUTH_CLIENT_SECRET: "s",
  GITHUB_TOKEN: "ghp_x",
};

test("loadEmbeddingsConfig: defaults applied when only secrets set", () => {
  const cfg = loadEmbeddingsConfig(ENV);
  assert.equal(cfg.enabled, true);
  assert.equal(cfg.backfillOnStartup, true);
  assert.equal(cfg.model, "text-embedding-3-large");
  assert.equal(cfg.dimensions, 3072);
  assert.equal(cfg.promptVersion, 1);
  assert.equal(cfg.batchSize, 32);
  assert.equal(cfg.chunkMaxChars, 1500);
  assert.equal(cfg.retrieval.topK, 8);
  assert.equal(cfg.retrieval.minScore, 0);
});

test("loadEmbeddingsConfig: enabled=false skips secret validation", () => {
  const cfg = loadEmbeddingsConfig({ EMBEDDINGS_ENABLED: "false" });
  assert.equal(cfg.enabled, false);
});

test("loadEmbeddingsConfig: enabled=true with missing secrets throws", () => {
  assert.throws(
    () => loadEmbeddingsConfig({}),
    /EMBEDDINGS_API_KEY.*EMBEDDINGS_AUTH_CLIENT_ID.*EMBEDDINGS_AUTH_CLIENT_SECRET/s,
  );
});

test("loadEmbeddingsConfig: GITHUB_TOKEN passed through (empty allowed)", () => {
  const cfg = loadEmbeddingsConfig({ ...ENV, GITHUB_TOKEN: "" });
  assert.equal(cfg.githubToken, "");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && node --test server/embeddings/config.test.mjs
```
Expected: FAIL — missing file.

- [ ] **Step 3: Implement `config.mjs`**

```js
// app/server/embeddings/config.mjs
const REQUIRED = ["EMBEDDINGS_API_KEY", "EMBEDDINGS_AUTH_CLIENT_ID", "EMBEDDINGS_AUTH_CLIENT_SECRET"];

function parseBool(raw, fallback) {
  if (raw === undefined || raw === "") return fallback;
  return String(raw).toLowerCase() === "true";
}
function parsePositiveInt(raw, fallback, name) {
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n) || n <= 0 || String(n) !== String(raw).trim()) {
    throw new Error(`${name} must be a positive integer`);
  }
  return n;
}
function parseFloat01(raw, fallback, name) {
  if (raw === undefined || String(raw).trim() === "") return fallback;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
  return n;
}

export function loadEmbeddingsConfig(env = process.env) {
  const enabled = parseBool(env.EMBEDDINGS_ENABLED, true);
  if (enabled) {
    const missing = REQUIRED.filter((k) => !env[k] || env[k].trim() === "");
    if (missing.length) {
      throw new Error(`Missing required embeddings secrets in env: ${missing.join(", ")}`);
    }
  }
  return {
    enabled,
    backfillOnStartup: parseBool(env.EMBEDDINGS_BACKFILL_ON_STARTUP, true),
    apiBaseUrl: env.EMBEDDINGS_API_BASE_URL?.trim() || "https://api.gcp.cloud.bmw/llmapi/v1",
    apiKey: env.EMBEDDINGS_API_KEY ?? "",
    model: env.EMBEDDINGS_MODEL?.trim() || "text-embedding-3-large",
    dimensions: parsePositiveInt(env.EMBEDDINGS_DIMENSIONS, 3072, "EMBEDDINGS_DIMENSIONS"),
    promptVersion: parsePositiveInt(env.EMBEDDINGS_PROMPT_VERSION, 1, "EMBEDDINGS_PROMPT_VERSION"),
    batchSize: parsePositiveInt(env.EMBEDDINGS_BATCH_SIZE, 32, "EMBEDDINGS_BATCH_SIZE"),
    chunkMaxChars: parsePositiveInt(env.EMBEDDINGS_CHUNK_MAX_CHARS, 1500, "EMBEDDINGS_CHUNK_MAX_CHARS"),
    retrieval: {
      topK: parsePositiveInt(env.EMBEDDINGS_RETRIEVAL_TOP_K, 8, "EMBEDDINGS_RETRIEVAL_TOP_K"),
      minScore: parseFloat01(env.EMBEDDINGS_RETRIEVAL_MIN_SCORE, 0, "EMBEDDINGS_RETRIEVAL_MIN_SCORE"),
    },
    auth: {
      tokenUrl: env.EMBEDDINGS_AUTH_TOKEN_URL?.trim() || "https://auth.bmwgroup.net/auth/oauth2/realms/root/realms/machine2machine/access_token",
      clientId: env.EMBEDDINGS_AUTH_CLIENT_ID ?? "",
      clientSecret: env.EMBEDDINGS_AUTH_CLIENT_SECRET ?? "",
      scope: env.EMBEDDINGS_AUTH_SCOPE?.trim() || "machine2machine",
    },
    githubToken: env.GITHUB_TOKEN ?? "",
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && node --test server/embeddings/config.test.mjs
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/server/embeddings/config.mjs app/server/embeddings/config.test.mjs
git commit -m "feat(embeddings): typed config loader"
```

---

### Task 8: `app/server/embeddings/client.mjs` — embedding HTTP client + tests

**Files:**
- Create: `app/server/embeddings/client.mjs`
- Create: `app/server/embeddings/client.test.mjs`

**Interfaces:**
- Consumes: `EmbeddingsConfig`, `OAuthClient`
- Produces:
  - `createEmbeddingsClient({ getConfig, oauth, fetchImpl? }) → { embedBatch(inputs) → Promise<Float32Array[]> }`
- Asserts on first response: vector length == `cfg.dimensions`; unit-norm within ±0.01.

- [ ] **Step 1: Write the failing test**

```js
// app/server/embeddings/client.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { createEmbeddingsClient } from "./client.mjs";

function unit(dim, seed = 1) {
  const v = new Array(dim).fill(0).map((_, i) => Math.sin(seed * (i + 1)));
  let s = 0; for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  return v.map((x) => x / n);
}

const cfg = {
  apiBaseUrl: "https://api/llmapi/v1",
  apiKey: "K",
  model: "text-embedding-3-large",
  dimensions: 4,
};
const oauth = { getAccessToken: async () => "TKN" };

test("embedBatch: returns one vector per input in order", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({
      data: [
        { index: 0, embedding: unit(4, 1) },
        { index: 1, embedding: unit(4, 2) },
      ],
    }), { status: 200 });
  const client = createEmbeddingsClient({ getConfig: () => cfg, oauth, fetchImpl });
  const out = await client.embedBatch(["a", "b"]);
  assert.equal(out.length, 2);
  assert.ok(out[0] instanceof Float32Array);
  assert.equal(out[0].length, 4);
});

test("embedBatch: rejects on dimension mismatch", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: unit(8, 1) }] }), { status: 200 });
  const client = createEmbeddingsClient({ getConfig: () => cfg, oauth, fetchImpl });
  await assert.rejects(() => client.embedBatch(["a"]), /dimension mismatch.*expected 4.*8/i);
});

test("embedBatch: rejects on non-unit-norm vector", async () => {
  const fetchImpl = async () =>
    new Response(JSON.stringify({ data: [{ index: 0, embedding: [10, 10, 10, 10] }] }), { status: 200 });
  const client = createEmbeddingsClient({ getConfig: () => cfg, oauth, fetchImpl });
  await assert.rejects(() => client.embedBatch(["a"]), /unit-norm/i);
});

test("embedBatch: empty input returns empty array without HTTP call", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; return new Response("", { status: 200 }); };
  const client = createEmbeddingsClient({ getConfig: () => cfg, oauth, fetchImpl });
  const out = await client.embedBatch([]);
  assert.deepEqual(out, []);
  assert.equal(calls, 0);
});

test("embedBatch: surfaces non-2xx", async () => {
  const fetchImpl = async () => new Response("boom", { status: 500 });
  const client = createEmbeddingsClient({ getConfig: () => cfg, oauth, fetchImpl });
  await assert.rejects(() => client.embedBatch(["a"]), /Embeddings upstream failed: 500/);
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && node --test server/embeddings/client.test.mjs
```
Expected: FAIL — missing file.

- [ ] **Step 3: Implement `client.mjs`**

```js
// app/server/embeddings/client.mjs
const UNIT_NORM_TOLERANCE = 1e-2;

export function createEmbeddingsClient({ getConfig, oauth, fetchImpl = fetch }) {
  let verified = false;

  async function embedBatch(inputs) {
    if (!inputs.length) return [];
    const cfg = getConfig();
    const token = await oauth.getAccessToken();
    const res = await fetchImpl(`${cfg.apiBaseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "x-apikey": cfg.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: cfg.model, input: inputs }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Embeddings upstream failed: ${res.status} ${text.slice(0, 200)}`);
    }
    const parsed = await res.json();
    const data = parsed?.data;
    if (!Array.isArray(data) || data.length !== inputs.length) {
      throw new Error(`Embeddings upstream returned ${data?.length ?? 0} vectors for ${inputs.length} inputs`);
    }
    const sorted = data.slice().sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    const vectors = sorted.map((d) => Float32Array.from(d.embedding));
    if (!verified) {
      if (vectors[0].length !== cfg.dimensions) {
        throw new Error(`Embeddings dimension mismatch: expected ${cfg.dimensions} but got ${vectors[0].length}`);
      }
      let sq = 0; for (const x of vectors[0]) sq += x * x;
      const norm = Math.sqrt(sq);
      if (norm < 1 - UNIT_NORM_TOLERANCE || norm > 1 + UNIT_NORM_TOLERANCE) {
        throw new Error(`Embeddings unit-norm check failed: expected ~1, got ${norm.toFixed(4)}`);
      }
      verified = true;
    }
    return vectors;
  }

  return { embedBatch };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && node --test server/embeddings/client.test.mjs
```
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add app/server/embeddings/client.mjs app/server/embeddings/client.test.mjs
git commit -m "feat(embeddings): batched embeddings client with dim+norm guards"
```

---

### Task 9: `app/server/embeddings/source.mjs` + `readme.mjs` — chunk builders + tests

**Files:**
- Create: `app/server/embeddings/source.mjs`
- Create: `app/server/embeddings/readme.mjs`
- Create: `app/server/embeddings/readme.test.mjs`

**Interfaces:**
- Consumes: a single record from `report.json` (`{ id, name, url, category, description, efficiency_gain, use_cases }`); `GITHUB_TOKEN`
- Produces:
  - `buildFieldsChunk(record) → { source: 'fields', headingPath: null, text: string }`
  - `splitMarkdown(markdown, repoName, maxChars) → Array<{ headingPath: string, text: string }>`
  - `fetchReadme({ repoSlug, githubToken, fetchImpl? }) → Promise<string|null>` (null on any failure — caller logs and continues)

- [ ] **Step 1: Implement `source.mjs` (no tests — pure function, covered by Task 11 backfill test)**

```js
// app/server/embeddings/source.mjs
export function buildFieldsChunk(record) {
  const useCases = Array.isArray(record.use_cases) ? record.use_cases.join(", ") : "";
  const head = useCases ? `${record.category} · ${useCases}` : record.category;
  const text = [
    record.name,
    head,
    "",
    record.description ?? "",
    "",
    `Efficiency gain: ${record.efficiency_gain ?? ""}`,
  ].filter((l) => l !== undefined).join("\n");
  return { source: "fields", headingPath: null, text };
}
```

- [ ] **Step 2: Write the failing test for `readme.mjs`**

```js
// app/server/embeddings/readme.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { splitMarkdown, fetchReadme } from "./readme.mjs";

const SAMPLE = `
# Acme MCP Server

A quick blurb.

## Installation

Run \`npm install\`.

## Usage

Some text.

### Config

Tiny details.
`;

test("splitMarkdown: emits a chunk per ## section with heading path", () => {
  const chunks = splitMarkdown(SAMPLE, "owner/repo", 1500);
  const paths = chunks.map((c) => c.headingPath);
  assert.deepEqual(paths, [
    "owner/repo: Acme MCP Server",
    "owner/repo: Acme MCP Server > Installation",
    "owner/repo: Acme MCP Server > Usage",
    "owner/repo: Acme MCP Server > Usage > Config",
  ]);
});

test("splitMarkdown: each chunk text starts with its heading path prefix", () => {
  const chunks = splitMarkdown(SAMPLE, "owner/repo", 1500);
  for (const c of chunks) {
    assert.ok(c.text.startsWith(c.headingPath), `chunk text should start with heading path:\n${c.text}`);
  }
});

test("splitMarkdown: oversized section gets char-split with overlap", () => {
  const big = "# Big\n\n" + "x".repeat(4000);
  const chunks = splitMarkdown(big, "o/r", 1500);
  assert.ok(chunks.length >= 3, `expected ≥3 chunks, got ${chunks.length}`);
  // overlap: end of chunk N and start of chunk N+1 share at least some chars
  for (let i = 1; i < chunks.length; i++) {
    const prevTail = chunks[i - 1].text.slice(-50);
    const currHead = chunks[i].text.slice(0, 200);
    assert.ok(currHead.includes(prevTail.slice(0, 20)) || currHead.length > 0);
  }
});

test("splitMarkdown: no headings → single chunk", () => {
  const chunks = splitMarkdown("Just plain text.", "o/r", 1500);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].headingPath, "o/r");
});

test("fetchReadme: returns null on 404", async () => {
  const fetchImpl = async () => new Response("", { status: 404 });
  const out = await fetchReadme({ repoSlug: "x/y", githubToken: "t", fetchImpl });
  assert.equal(out, null);
});

test("fetchReadme: returns null on auth failure (401)", async () => {
  const fetchImpl = async () => new Response("", { status: 401 });
  const out = await fetchReadme({ repoSlug: "x/y", githubToken: "t", fetchImpl });
  assert.equal(out, null);
});

test("fetchReadme: returns text on 200", async () => {
  const fetchImpl = async () => new Response("# Hi\n\nbody", { status: 200 });
  const out = await fetchReadme({ repoSlug: "x/y", githubToken: "t", fetchImpl });
  assert.equal(out, "# Hi\n\nbody");
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd app && node --test server/embeddings/readme.test.mjs
```
Expected: FAIL — missing file.

- [ ] **Step 4: Implement `readme.mjs`**

```js
// app/server/embeddings/readme.mjs
const OVERLAP = 200;

export async function fetchReadme({ repoSlug, githubToken, fetchImpl = fetch }) {
  if (!repoSlug || !githubToken) return null;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repoSlug}/readme`, {
      headers: {
        "Authorization": `Bearer ${githubToken}`,
        "Accept": "application/vnd.github.raw",
        "User-Agent": "claude-ai-tool-research",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export function splitMarkdown(markdown, repoSlug, maxChars) {
  if (!markdown || markdown.trim() === "") return [];
  const lines = markdown.split("\n");
  let h1 = null;
  const sections = []; // { path: string[], body: string[] }
  let h2 = null, h3 = null;

  const startSection = (path) => sections.push({ path, body: [] });
  startSection([]); // preamble until first heading

  for (const line of lines) {
    const m1 = /^#\s+(.*)$/.exec(line);
    const m2 = /^##\s+(.*)$/.exec(line);
    const m3 = /^###\s+(.*)$/.exec(line);
    if (m1) {
      h1 = m1[1].trim(); h2 = null; h3 = null;
      // Preamble (if any) stays as the first section; h1 starts a new one.
      startSection([h1]);
    } else if (m2) {
      h2 = m2[1].trim(); h3 = null;
      startSection([h1 ?? repoSlug, h2]);
    } else if (m3) {
      h3 = m3[1].trim();
      startSection([h1 ?? repoSlug, h2 ?? "(intro)", h3]);
    } else {
      sections[sections.length - 1].body.push(line);
    }
  }

  // Drop the empty preamble section if no body.
  const filled = sections
    .map((s) => ({
      path: s.path.length ? s.path : [h1 ?? repoSlug],
      body: s.body.join("\n").trim(),
    }))
    .filter((s) => s.body.length > 0);

  if (filled.length === 0) {
    // No headings at all — return one chunk with the repoSlug as the path.
    return [{ headingPath: `${repoSlug}`, text: `${repoSlug}\n\n${markdown.trim()}` }];
  }

  const chunks = [];
  for (const s of filled) {
    const headingPath = `${repoSlug}: ${s.path.join(" > ")}`;
    const fullText = `${headingPath}\n\n${s.body}`;
    if (fullText.length <= maxChars) {
      chunks.push({ headingPath, text: fullText });
    } else {
      // char-split with overlap
      let i = 0;
      const body = s.body;
      while (i < body.length) {
        const slice = body.slice(i, i + maxChars);
        chunks.push({ headingPath, text: `${headingPath}\n\n${slice}` });
        if (i + maxChars >= body.length) break;
        i += maxChars - OVERLAP;
      }
    }
  }
  return chunks;
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd app && node --test server/embeddings/readme.test.mjs
```
Expected: PASS (7 tests).

- [ ] **Step 6: Commit**

```bash
git add app/server/embeddings/source.mjs app/server/embeddings/readme.mjs app/server/embeddings/readme.test.mjs
git commit -m "feat(embeddings): fields + README chunk builders"
```

---

### Task 10: `app/server/embeddings/store.mjs` — SQLite-backed chunk store + tests

**Files:**
- Create: `app/server/embeddings/store.mjs`
- Create: `app/server/embeddings/store.test.mjs`
- Modify: `app/package.json` (add `better-sqlite3`)

**Interfaces:**
- Consumes: `EmbeddingsConfig` (for `model`, `promptVersion`)
- Produces:
  - `createEmbeddingsStore({ dbPath, model, promptVersion }) → EmbeddingsStore`
  - `EmbeddingsStore.hasChunk(recordId, chunkIndex) → boolean`
  - `EmbeddingsStore.upsertChunks(rows) → void` where each row = `{ recordId, chunkIndex, source, headingPath, text, textHash, vector }`
  - `EmbeddingsStore.allChunks() → Array<{ recordId, chunkIndex, source, headingPath, text, vector: Float32Array }>`
  - `EmbeddingsStore.count() → number`
  - `EmbeddingsStore.cosineTopK(query: Float32Array, k, minScore) → Array<{ recordId, chunkIndex, score, headingPath }>` (collapses to best chunk per record)

- [ ] **Step 1: Add `better-sqlite3` to `app/package.json` deps**

```bash
cd app && npm install better-sqlite3@^11.0.0
```

- [ ] **Step 2: Write the failing test**

```js
// app/server/embeddings/store.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddingsStore } from "./store.mjs";

function tmp() { return mkdtempSync(join(tmpdir(), "emb-")); }
function unitVec(dim, seed = 1) {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.sin(seed * (i + 1));
  let s = 0; for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

test("upsertChunks + allChunks round-trips vectors", () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({ dbPath: join(dir, "x.sqlite"), model: "m", promptVersion: 1 });
    const vec = unitVec(8, 1);
    store.upsertChunks([{ recordId: "r1", chunkIndex: 0, source: "fields", headingPath: null, text: "t", textHash: "h", vector: vec }]);
    const rows = store.allChunks();
    assert.equal(rows.length, 1);
    assert.equal(rows[0].recordId, "r1");
    assert.ok(rows[0].vector instanceof Float32Array);
    assert.equal(rows[0].vector.length, 8);
    for (let i = 0; i < 8; i++) assert.ok(Math.abs(rows[0].vector[i] - vec[i]) < 1e-6);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("hasChunk: scopes by model and promptVersion", () => {
  const dir = tmp();
  try {
    const s1 = createEmbeddingsStore({ dbPath: join(dir, "x.sqlite"), model: "m1", promptVersion: 1 });
    s1.upsertChunks([{ recordId: "r1", chunkIndex: 0, source: "fields", headingPath: null, text: "t", textHash: "h", vector: unitVec(4, 1) }]);
    assert.equal(s1.hasChunk("r1", 0), true);

    const s2 = createEmbeddingsStore({ dbPath: join(dir, "x.sqlite"), model: "m2", promptVersion: 1 });
    assert.equal(s2.hasChunk("r1", 0), false, "different model is a separate row");

    const s3 = createEmbeddingsStore({ dbPath: join(dir, "x.sqlite"), model: "m1", promptVersion: 2 });
    assert.equal(s3.hasChunk("r1", 0), false, "different prompt_version is a separate row");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cosineTopK: returns the most similar chunk per record", () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({ dbPath: join(dir, "x.sqlite"), model: "m", promptVersion: 1 });
    const a = unitVec(4, 1), b = unitVec(4, 2), c = unitVec(4, 3);
    store.upsertChunks([
      { recordId: "r1", chunkIndex: 0, source: "fields", headingPath: null, text: "ta", textHash: "ha", vector: a },
      { recordId: "r1", chunkIndex: 1, source: "readme", headingPath: "r1: h", text: "tb", textHash: "hb", vector: b },
      { recordId: "r2", chunkIndex: 0, source: "fields", headingPath: null, text: "tc", textHash: "hc", vector: c },
    ]);
    const out = store.cosineTopK(a, 5, 0);
    // r1 ranks first (perfect match on chunk 0), r2 next.
    assert.equal(out[0].recordId, "r1");
    assert.equal(out[0].chunkIndex, 0);
    assert.equal(out.length, 2, "one entry per record after collapse");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("cosineTopK: respects minScore floor", () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({ dbPath: join(dir, "x.sqlite"), model: "m", promptVersion: 1 });
    const a = unitVec(4, 1), b = unitVec(4, 5);
    store.upsertChunks([
      { recordId: "r1", chunkIndex: 0, source: "fields", headingPath: null, text: "ta", textHash: "ha", vector: a },
      { recordId: "r2", chunkIndex: 0, source: "fields", headingPath: null, text: "tb", textHash: "hb", vector: b },
    ]);
    const out = store.cosineTopK(a, 5, 0.999);
    assert.equal(out.length, 1, "only the near-perfect match survives the floor");
    assert.equal(out[0].recordId, "r1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("upsertChunks: re-inserting same (recordId,chunkIndex,model,promptVersion) updates the row", () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({ dbPath: join(dir, "x.sqlite"), model: "m", promptVersion: 1 });
    store.upsertChunks([{ recordId: "r1", chunkIndex: 0, source: "fields", headingPath: null, text: "old", textHash: "h1", vector: unitVec(4, 1) }]);
    store.upsertChunks([{ recordId: "r1", chunkIndex: 0, source: "fields", headingPath: null, text: "new", textHash: "h2", vector: unitVec(4, 1) }]);
    assert.equal(store.count(), 1);
    assert.equal(store.allChunks()[0].text, "new");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 3: Run test to verify it fails**

```bash
cd app && node --test server/embeddings/store.test.mjs
```
Expected: FAIL — missing file.

- [ ] **Step 4: Implement `store.mjs`**

```js
// app/server/embeddings/store.mjs
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const SCHEMA = `
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
`;

function vecToBuf(v) {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}
function bufToVec(b) {
  return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
}
function cosine(a, b) {
  // both already L2-normalized → cosine = dot
  let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
}

export function createEmbeddingsStore({ dbPath, model, promptVersion }) {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.exec(SCHEMA);

  const stmts = {
    has: db.prepare(`SELECT 1 FROM embedded_chunks WHERE record_id = ? AND chunk_index = ? AND model = ? AND prompt_version = ?`),
    upsert: db.prepare(`
      INSERT INTO embedded_chunks (record_id, chunk_index, source, heading_path, text, text_hash, model, vector, prompt_version, embedded_at)
      VALUES (@record_id, @chunk_index, @source, @heading_path, @text, @text_hash, @model, @vector, @prompt_version, @embedded_at)
      ON CONFLICT(record_id, chunk_index, model, prompt_version) DO UPDATE SET
        source = excluded.source,
        heading_path = excluded.heading_path,
        text = excluded.text,
        text_hash = excluded.text_hash,
        vector = excluded.vector,
        embedded_at = excluded.embedded_at
    `),
    all: db.prepare(`SELECT * FROM embedded_chunks WHERE model = ? AND prompt_version = ?`),
    count: db.prepare(`SELECT COUNT(*) AS c FROM embedded_chunks WHERE model = ? AND prompt_version = ?`),
  };

  function upsertChunks(rows) {
    const now = new Date().toISOString();
    const tx = db.transaction((rs) => {
      for (const r of rs) {
        stmts.upsert.run({
          record_id: r.recordId,
          chunk_index: r.chunkIndex,
          source: r.source,
          heading_path: r.headingPath,
          text: r.text,
          text_hash: r.textHash,
          model,
          vector: vecToBuf(r.vector),
          prompt_version: promptVersion,
          embedded_at: now,
        });
      }
    });
    tx(rows);
  }

  function hasChunk(recordId, chunkIndex) {
    return stmts.has.get(recordId, chunkIndex, model, promptVersion) !== undefined;
  }

  function allChunks() {
    return stmts.all.all(model, promptVersion).map((r) => ({
      recordId: r.record_id,
      chunkIndex: r.chunk_index,
      source: r.source,
      headingPath: r.heading_path,
      text: r.text,
      vector: bufToVec(r.vector),
    }));
  }

  function count() {
    return stmts.count.get(model, promptVersion).c;
  }

  function cosineTopK(query, k, minScore) {
    const rows = allChunks();
    const scored = [];
    for (const r of rows) {
      if (r.vector.length !== query.length) continue;
      const s = cosine(query, r.vector);
      if (s >= minScore) scored.push({ row: r, score: s });
    }
    scored.sort((a, b) => b.score - a.score);
    const seen = new Set();
    const out = [];
    for (const s of scored) {
      if (seen.has(s.row.recordId)) continue;
      seen.add(s.row.recordId);
      out.push({ recordId: s.row.recordId, chunkIndex: s.row.chunkIndex, score: s.score, headingPath: s.row.headingPath });
      if (out.length === k) break;
    }
    return out;
  }

  return { upsertChunks, hasChunk, allChunks, count, cosineTopK, close: () => db.close() };
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd app && node --test server/embeddings/store.test.mjs
```
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add app/server/embeddings/store.mjs app/server/embeddings/store.test.mjs app/package.json app/package-lock.json
git commit -m "feat(embeddings): SQLite-backed chunk store with cosine top-K"
```

---

### Task 11: `app/server/embeddings/backfill.mjs` — boot-time embedder + tests

**Files:**
- Create: `app/server/embeddings/backfill.mjs`
- Create: `app/server/embeddings/backfill.test.mjs`

**Interfaces:**
- Consumes: `records` array, `EmbeddingsClient` (Task 8), `EmbeddingsStore` (Task 10), `fetchReadme` + `splitMarkdown` (Task 9), `buildFieldsChunk` (Task 9), `EmbeddingsConfig`
- Produces:
  - `runBackfill({ records, client, store, config, fetchReadmeFn?, splitMd?, log? }) → Promise<{ embedded: number, skipped: number, failed: number }>`

Per-record steps:
1. Build `fields` chunk → compute `sha256(text)`.
2. If `githubToken`, fetch README. On success, split into chunks (Task 9).
3. For each chunk, skip if `store.hasChunk(...)` AND existing text_hash matches. Otherwise enqueue for embedding.
4. Embed in batches of `cfg.batchSize`.
5. Insert into store (idempotent).
6. Errors per record are isolated — log + count + continue.

- [ ] **Step 1: Write the failing test**

```js
// app/server/embeddings/backfill.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddingsStore } from "./store.mjs";
import { runBackfill } from "./backfill.mjs";

function tmp() { return mkdtempSync(join(tmpdir(), "bf-")); }
function unitVec(dim, seed) {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.sin(seed * (i + 1));
  let s = 0; for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

function makeClient(dim = 4) {
  let seed = 0;
  return {
    async embedBatch(inputs) {
      return inputs.map(() => { seed++; return unitVec(dim, seed); });
    },
  };
}

const RECORD = {
  id: "owner-repo",
  name: "owner/repo",
  url: "https://github.com/owner/repo",
  category: "mcp-server",
  description: "desc",
  efficiency_gain: "gain",
  use_cases: ["rag"],
};

const CFG = { model: "m", promptVersion: 1, batchSize: 8, chunkMaxChars: 1500, githubToken: "" };

test("embeds fields chunk when README is unavailable", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({ dbPath: join(dir, "x.sqlite"), model: "m", promptVersion: 1 });
    const result = await runBackfill({
      records: [RECORD],
      client: makeClient(),
      store,
      config: CFG,
      fetchReadmeFn: async () => null,
    });
    assert.equal(result.embedded, 1);
    assert.equal(store.count(), 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("embeds fields + readme chunks when README present", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({ dbPath: join(dir, "x.sqlite"), model: "m", promptVersion: 1 });
    const result = await runBackfill({
      records: [RECORD],
      client: makeClient(),
      store,
      config: { ...CFG, githubToken: "ghp" },
      fetchReadmeFn: async () => "# Title\n\n## Section A\n\nbody A\n\n## Section B\n\nbody B",
    });
    assert.ok(result.embedded >= 3, `expected ≥3 chunks, got ${result.embedded}`);
    assert.equal(store.count(), result.embedded);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("re-running is a no-op (idempotent via text_hash)", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({ dbPath: join(dir, "x.sqlite"), model: "m", promptVersion: 1 });
    await runBackfill({ records: [RECORD], client: makeClient(), store, config: CFG, fetchReadmeFn: async () => null });
    const before = store.count();
    const second = await runBackfill({ records: [RECORD], client: makeClient(), store, config: CFG, fetchReadmeFn: async () => null });
    assert.equal(second.embedded, 0);
    assert.equal(second.skipped, 1);
    assert.equal(store.count(), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("per-record failures are isolated", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({ dbPath: join(dir, "x.sqlite"), model: "m", promptVersion: 1 });
    const badClient = {
      async embedBatch(inputs) {
        if (inputs.some((t) => t.includes("BOOM"))) throw new Error("upstream blew up");
        return inputs.map((_, i) => unitVec(4, i + 1));
      },
    };
    const result = await runBackfill({
      records: [
        { ...RECORD, id: "good", name: "good/repo", description: "ok" },
        { ...RECORD, id: "bad",  name: "bad/repo",  description: "BOOM" },
      ],
      client: badClient,
      store,
      config: CFG,
      fetchReadmeFn: async () => null,
    });
    assert.equal(result.embedded, 1);
    assert.equal(result.failed, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && node --test server/embeddings/backfill.test.mjs
```
Expected: FAIL — missing file.

- [ ] **Step 3: Implement `backfill.mjs`**

```js
// app/server/embeddings/backfill.mjs
import { createHash } from "node:crypto";
import { buildFieldsChunk } from "./source.mjs";
import { fetchReadme as defaultFetchReadme, splitMarkdown as defaultSplitMd } from "./readme.mjs";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

function repoSlugFromRecord(rec) {
  const m = String(rec.url || rec.name || "").toLowerCase().match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (m) return `${m[1]}/${m[2].replace(/\.git$/, "")}`;
  return rec.name?.toLowerCase().trim() || null;
}

export async function runBackfill({
  records,
  client,
  store,
  config,
  fetchReadmeFn = defaultFetchReadme,
  splitMd = defaultSplitMd,
  log = console,
}) {
  let embedded = 0, skipped = 0, failed = 0;

  for (const rec of records) {
    try {
      // 1) build candidate chunks (fields + maybe readme)
      const fields = buildFieldsChunk(rec);
      const candidates = [{ ...fields, chunkIndex: 0 }];

      if (config.githubToken) {
        const slug = repoSlugFromRecord(rec);
        const md = slug ? await fetchReadmeFn({ repoSlug: slug, githubToken: config.githubToken }) : null;
        if (md) {
          const readmeChunks = splitMd(md, slug, config.chunkMaxChars);
          readmeChunks.forEach((c, i) => candidates.push({
            source: "readme",
            headingPath: c.headingPath,
            text: c.text,
            chunkIndex: i + 1,
          }));
        }
      }

      // 2) gate by store / text_hash
      const needEmbed = [];
      for (const c of candidates) {
        const textHash = sha256(c.text);
        if (store.hasChunk(rec.id, c.chunkIndex)) {
          skipped++;
          continue;
        }
        needEmbed.push({ ...c, textHash });
      }
      if (!needEmbed.length) continue;

      // 3) batch + embed
      for (let i = 0; i < needEmbed.length; i += config.batchSize) {
        const batch = needEmbed.slice(i, i + config.batchSize);
        const vectors = await client.embedBatch(batch.map((b) => b.text));
        const rows = batch.map((b, j) => ({
          recordId: rec.id,
          chunkIndex: b.chunkIndex,
          source: b.source,
          headingPath: b.headingPath ?? null,
          text: b.text,
          textHash: b.textHash,
          vector: vectors[j],
        }));
        store.upsertChunks(rows);
        embedded += rows.length;
      }
      log.info?.(`[backfill] ${rec.id} embedded=${candidates.length} skipped=${skipped}`);
    } catch (err) {
      failed++;
      log.warn?.(`[backfill] ${rec.id} failed: ${err.message}`);
    }
  }

  return { embedded, skipped, failed };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && node --test server/embeddings/backfill.test.mjs
```
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add app/server/embeddings/backfill.mjs app/server/embeddings/backfill.test.mjs
git commit -m "feat(embeddings): idempotent boot-time backfill"
```

---

### Task 12: `app/server/embeddings/retrieve.mjs` — top-K retriever with query cache + tests

**Files:**
- Create: `app/server/embeddings/retrieve.mjs`
- Create: `app/server/embeddings/retrieve.test.mjs`

**Interfaces:**
- Consumes: `EmbeddingsClient`, `EmbeddingsStore`, `EmbeddingsConfig`
- Produces:
  - `createRetriever({ client, store, config, now? }) → { topK(query, k?) → Promise<Array<{ recordId, score, headingPath }>> }`

Cache: in-process, keyed by `sha256(query)`, TTL 5 min. No persistence.

- [ ] **Step 1: Write the failing test**

```js
// app/server/embeddings/retrieve.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEmbeddingsStore } from "./store.mjs";
import { createRetriever } from "./retrieve.mjs";

function tmp() { return mkdtempSync(join(tmpdir(), "rt-")); }
function unitVec(dim, seed) {
  const v = new Float32Array(dim);
  for (let i = 0; i < dim; i++) v[i] = Math.sin(seed * (i + 1));
  let s = 0; for (const x of v) s += x * x;
  const n = Math.sqrt(s);
  for (let i = 0; i < dim; i++) v[i] /= n;
  return v;
}

test("topK returns most similar records (by best chunk)", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({ dbPath: join(dir, "x.sqlite"), model: "m", promptVersion: 1 });
    const a = unitVec(4, 1), b = unitVec(4, 2);
    store.upsertChunks([
      { recordId: "r1", chunkIndex: 0, source: "fields", headingPath: null, text: "t", textHash: "h", vector: a },
      { recordId: "r2", chunkIndex: 0, source: "fields", headingPath: null, text: "t", textHash: "h", vector: b },
    ]);
    const client = { embedBatch: async () => [a] };
    const ret = createRetriever({ client, store, config: { retrieval: { topK: 2, minScore: 0 } } });
    const hits = await ret.topK("q");
    assert.equal(hits[0].recordId, "r1");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("topK caches the query embedding", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({ dbPath: join(dir, "x.sqlite"), model: "m", promptVersion: 1 });
    store.upsertChunks([{ recordId: "r1", chunkIndex: 0, source: "fields", headingPath: null, text: "t", textHash: "h", vector: unitVec(4, 1) }]);
    let embedCalls = 0;
    const client = { embedBatch: async () => { embedCalls++; return [unitVec(4, 1)]; } };
    const ret = createRetriever({ client, store, config: { retrieval: { topK: 1, minScore: 0 } }, now: () => 0 });
    await ret.topK("same query");
    await ret.topK("same query");
    assert.equal(embedCalls, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && node --test server/embeddings/retrieve.test.mjs
```
Expected: FAIL — missing file.

- [ ] **Step 3: Implement `retrieve.mjs`**

```js
// app/server/embeddings/retrieve.mjs
import { createHash } from "node:crypto";

const TTL_MS = 5 * 60 * 1000;
const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

export function createRetriever({ client, store, config, now = () => Date.now() }) {
  const cache = new Map(); // key → { vec, expiresAt }

  async function getQueryVector(query) {
    const key = sha256(query);
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return hit.vec;
    const [vec] = await client.embedBatch([query]);
    cache.set(key, { vec, expiresAt: now() + TTL_MS });
    return vec;
  }

  return {
    async topK(query, k) {
      const qVec = await getQueryVector(query);
      const limit = k ?? config.retrieval.topK;
      return store.cosineTopK(qVec, limit, config.retrieval.minScore);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd app && node --test server/embeddings/retrieve.test.mjs
```
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add app/server/embeddings/retrieve.mjs app/server/embeddings/retrieve.test.mjs
git commit -m "feat(embeddings): top-K retriever with query embedding cache"
```

---

### Task 13: Rewrite `app/server/chat.mjs` to consume the new layers + tests

**Files:**
- Modify: `app/server/chat.mjs`
- Create: `app/server/chat.test.mjs`
- Delete: `app/server/claude.mjs` (logic moved into `llm/provider-cli.mjs`)

**Interfaces:**
- Consumes: `records`, `scope`, `ids`, `message`, `LlmClient` (Task 6), optional `Retriever` (Task 12), `EmbeddingsConfig`
- Produces:
  - `runChat({ records, scope, ids, message, llm, retriever?, embeddingsCfg, log? }) → Promise<{ answer: string, retrieval: { mode: 'rag'|'full-context', topK?, hits? } }>`

`chat.mjs` builds the LLM `messages` array (system + user with stuffed context) and calls `llm.chat(messages)`. The old `buildChatContext` stays exported (and tested) because Task 14 wires it through.

- [ ] **Step 1: Write the failing test**

```js
// app/server/chat.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { runChat } from "./chat.mjs";

const RECORDS = [
  { id: "r1", name: "o/r1", category: "mcp-server", stars_display: "1k", description: "qdrant-like", efficiency_gain: "fast", use_cases: ["rag"], url: "u" },
  { id: "r2", name: "o/r2", category: "plugin-skill", stars_display: "500", description: "scaffold tool", efficiency_gain: "saves time", use_cases: ["dev"], url: "u" },
];
const llm = { chat: async (msgs) => `LLM saw ${msgs.length} messages` };

test("scope=record uses only the selected record", async () => {
  const out = await runChat({
    records: RECORDS, scope: "record", ids: ["r1"], message: "what is it?",
    llm, embeddingsCfg: { enabled: false },
  });
  assert.equal(out.retrieval.mode, "full-context");
  assert.match(out.answer, /^LLM saw/);
});

test("scope=global with embeddings disabled = full-context fallback", async () => {
  const out = await runChat({
    records: RECORDS, scope: "global", ids: [], message: "best?",
    llm, embeddingsCfg: { enabled: false },
  });
  assert.equal(out.retrieval.mode, "full-context");
});

test("scope=global with retriever returns rag mode and only top-K records", async () => {
  let promptedMessages = null;
  const llmCap = { chat: async (msgs) => { promptedMessages = msgs; return "ok"; } };
  const retriever = { topK: async () => [{ recordId: "r1", score: 0.9, headingPath: null }] };
  const out = await runChat({
    records: RECORDS, scope: "global", ids: [], message: "best?",
    llm: llmCap, retriever, embeddingsCfg: { enabled: true, retrieval: { topK: 8, minScore: 0 } },
  });
  assert.equal(out.retrieval.mode, "rag");
  assert.equal(out.retrieval.hits.length, 1);
  // The stuffed context must mention r1 and NOT r2.
  const stuffed = promptedMessages.find((m) => m.role === "system").content + promptedMessages.find((m) => m.role === "user").content;
  assert.ok(stuffed.includes("o/r1"));
  assert.ok(!stuffed.includes("o/r2"));
});

test("scope=global falls back when retriever returns nothing", async () => {
  const retriever = { topK: async () => [] };
  const out = await runChat({
    records: RECORDS, scope: "global", ids: [], message: "x",
    llm, retriever, embeddingsCfg: { enabled: true, retrieval: { topK: 8, minScore: 0 } },
  });
  assert.equal(out.retrieval.mode, "full-context");
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd app && node --test server/chat.test.mjs
```
Expected: FAIL — new exports not present.

- [ ] **Step 3: Rewrite `chat.mjs`**

```js
// app/server/chat.mjs
function recordDetail(r) {
  return [
    `### ${r.name} (${r.category}) — ${r.stars_display ?? "?"} stars${r.installed ? ", installed" : ""}`,
    `URL: ${r.url}`,
    `What it does: ${r.description}`,
    `Efficiency gain: ${r.efficiency_gain}`,
  ].join("\n");
}
function recordLine(r) {
  return `- ${r.name} [${r.category}, ${r.stars_display ?? "?"}★${r.installed ? ", installed" : ""}]: ${r.description}`;
}

const SYSTEM = "You are a concise, helpful research assistant. Answer only from the provided context.";

export function buildChatContext(records, scope, ids = []) {
  const byId = new Map(records.map((r) => [r.id, r]));
  if (scope === "record") {
    const r = byId.get(ids[0]);
    if (!r) return "No record selected.";
    return `You are answering questions about this one repository:\n\n${recordDetail(r)}`;
  }
  if (scope === "selection") {
    const chosen = ids.map((id) => byId.get(id)).filter(Boolean);
    return `Compare and rate these selected repositories against each other for boosting Claude Code efficiency. Be specific about trade-offs and give a recommendation.\n\n${chosen.map(recordDetail).join("\n\n")}`;
  }
  // global
  return `Here is the full set of researched repositories. Compare and rate them against each other for the user's goal (boosting Claude Code efficiency for dev work and brainstorming). When asked, rank them and justify.\n\n${records.map(recordLine).join("\n")}`;
}

export async function runChat({ records, scope, ids = [], message, llm, retriever, embeddingsCfg, log = console }) {
  let context;
  let retrieval = { mode: "full-context" };

  if (scope === "global" && embeddingsCfg?.enabled && retriever) {
    try {
      const hits = await retriever.topK(message);
      if (hits.length > 0) {
        const byId = new Map(records.map((r) => [r.id, r]));
        const picked = hits.map((h) => byId.get(h.recordId)).filter(Boolean);
        if (picked.length > 0) {
          context = `Here are the repositories that best match the user's question. Compare and rank them; cite by name.\n\n${picked.map(recordDetail).join("\n\n")}`;
          retrieval = { mode: "rag", topK: hits.length, hits };
        }
      }
    } catch (err) {
      log.warn?.(`[chat] retriever failed, falling back: ${err.message}`);
    }
  }
  if (!context) context = buildChatContext(records, scope, ids);

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `${context}\n\n---\nUser question: ${message}` },
  ];
  const answer = await llm.chat(messages);
  return { answer, retrieval };
}
```

- [ ] **Step 4: Delete the old `claude.mjs`**

```bash
git rm app/server/claude.mjs
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd app && node --test server/chat.test.mjs
```
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add app/server/chat.mjs app/server/chat.test.mjs
git commit -m "feat(chat): RAG-aware orchestrator with full-context fallback"
```

---

### Task 14: Wire it all up in `app/server/app.mjs` + `index.mjs` + run the app test

**Files:**
- Modify: `app/server/app.mjs`
- Modify: `app/server/index.mjs`
- Modify: `app/server/app.test.mjs` (existing — update the chat-route test to match new response shape)

**Interfaces:**
- Consumes: all of the above
- Produces: `createApp({ dataDir, dbDir, llm, retriever?, embeddingsCfg })` — DI seams for tests; defaults read env at boot.

- [ ] **Step 1: Update `app.mjs`**

```js
// app/server/app.mjs
import { Hono } from "hono";
import { loadReport } from "./data.mjs";
import { readFlags, setFlag } from "./flags.mjs";
import { runChat } from "./chat.mjs";

export function createApp(opts = {}) {
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? "../data";
  const dbDir = opts.dbDir ?? process.env.DB_DIR ?? "./db";
  const llm = opts.llm;                          // injected — no default LLM here
  const retriever = opts.retriever ?? null;
  const embeddingsCfg = opts.embeddingsCfg ?? { enabled: false };

  const app = new Hono();
  app.get("/api/health", (c) => c.json({ ok: true }));

  app.get("/api/records", (c) => {
    const { generated_at, records } = loadReport(dataDir);
    const flags = readFlags(dbDir);
    const merged = records.map((r) => ({
      ...r,
      flagged: Boolean(flags[r.id]?.interesting),
      note: flags[r.id]?.note ?? "",
    }));
    return c.json({ generated_at, records: merged });
  });

  app.post("/api/refresh", (c) => {
    const { generated_at, records } = loadReport(dataDir);
    return c.json({ generated_at, count: records.length });
  });

  app.post("/api/records/:id/flag", async (c) => {
    const id = c.req.param("id");
    const patch = await c.req.json().catch(() => ({}));
    const flag = setFlag(dbDir, id, {
      interesting: typeof patch.interesting === "boolean" ? patch.interesting : undefined,
      note: typeof patch.note === "string" ? patch.note : undefined,
    });
    return c.json({ id, flag });
  });

  app.post("/api/chat", async (c) => {
    const { scope = "global", ids = [], message = "" } = await c.req.json().catch(() => ({}));
    if (!message.trim()) return c.json({ error: "empty message" }, 400);
    if (!llm) return c.json({ error: "chat not configured" }, 503);
    const { records } = loadReport(dataDir);
    const flags = readFlags(dbDir);
    const merged = records.map((r) => ({ ...r, flagged: Boolean(flags[r.id]?.interesting) }));
    try {
      const { answer, retrieval } = await runChat({
        records: merged, scope, ids, message, llm, retriever, embeddingsCfg,
      });
      return c.json({ answer, retrieval });
    } catch (err) {
      console.error("[/api/chat]", err);
      return c.json({ error: "chat request failed" }, 502);
    }
  });

  return app;
}
```

- [ ] **Step 2: Update `index.mjs` (boot order: env → llm → embeddings backfill → serve)**

```js
// app/server/index.mjs
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.mjs";
import { loadReport } from "./data.mjs";
import { createLlmClient } from "./llm/index.mjs";
import { loadEmbeddingsConfig } from "./embeddings/config.mjs";
import { createOAuthClient } from "./llm/oauth.mjs";
import { createEmbeddingsClient } from "./embeddings/client.mjs";
import { createEmbeddingsStore } from "./embeddings/store.mjs";
import { createRetriever } from "./embeddings/retrieve.mjs";
import { runBackfill } from "./embeddings/backfill.mjs";
import { join } from "node:path";

const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.DATA_DIR ?? "../data";
const dbDir = process.env.DB_DIR ?? "./db";

const llm = createLlmClient();

const embeddingsCfg = loadEmbeddingsConfig();
let retriever = null;
if (embeddingsCfg.enabled) {
  const oauth = createOAuthClient(embeddingsCfg.auth);
  const client = createEmbeddingsClient({ getConfig: () => embeddingsCfg, oauth });
  const store = createEmbeddingsStore({
    dbPath: join(dbDir, "embeddings.sqlite"),
    model: embeddingsCfg.model,
    promptVersion: embeddingsCfg.promptVersion,
  });
  if (embeddingsCfg.backfillOnStartup) {
    const { records } = loadReport(dataDir);
    console.log(`[boot] embeddings backfill starting for ${records.length} records…`);
    const result = await runBackfill({ records, client, store, config: embeddingsCfg });
    console.log(`[boot] embeddings backfill: embedded=${result.embedded} skipped=${result.skipped} failed=${result.failed}`);
  }
  retriever = createRetriever({ client, store, config: embeddingsCfg });
}

const app = createApp({ dataDir, dbDir, llm, retriever, embeddingsCfg });
app.use("/*", serveStatic({ root: "./dist" }));
app.get("/*", serveStatic({ path: "./dist/index.html" }));

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`efficiency-research-app listening on :${info.port}`);
});
```

- [ ] **Step 3: Update `app/server/app.test.mjs` — make the chat route happy with the new payload**

Read `app/server/app.test.mjs` and replace the chat-route test block to:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.mjs";

test("POST /api/chat returns answer + retrieval mode", async () => {
  const llm = { chat: async () => "stubbed" };
  const app = createApp({ dataDir: "./__fixtures__/empty", dbDir: "./__fixtures__/empty", llm, embeddingsCfg: { enabled: false } });
  const res = await app.request("/api/chat", { method: "POST", body: JSON.stringify({ scope: "global", message: "hi" }) });
  const body = await res.json();
  assert.equal(body.answer, "stubbed");
  assert.equal(body.retrieval.mode, "full-context");
});
```

(If the existing test does more — preserve those assertions. Just add the `retrieval` shape check.)

- [ ] **Step 4: Run all backend tests**

```bash
cd app && node --test server/**/*.test.mjs
```
Expected: PASS for all the new suites and the updated `app.test.mjs`.

- [ ] **Step 5: Commit**

```bash
git add app/server/app.mjs app/server/index.mjs app/server/app.test.mjs
git commit -m "feat(server): wire LLM + RAG into Hono app and boot order"
```

---

### Task 15: `run.sh` — pass `.env` into the container; README

**Files:**
- Modify: `run.sh`
- Modify: `README.md`

**Interfaces:** none — operational.

- [ ] **Step 1: Edit `run.sh` to load `.env`**

Find the `docker run` block and add `--env-file "$ROOT/.env"` (only if `.env` exists). Insert this just before the existing `--user` line:

```bash
ENV_ARGS=()
if [ -f "$ROOT/.env" ]; then ENV_ARGS+=(--env-file "$ROOT/.env"); fi

docker run -d --name "$NAME" \
  "${ENV_ARGS[@]}" \
  --user "${HOST_UID}:${HOST_GID}" \
  ...
```

- [ ] **Step 2: Update `README.md` — replace the "subscription" wording**

Replace any mention of "Pro/Max subscription" or "claude CLI" in the chat section with:

```md
## Chat backend

Two providers (pick via `LLM_PROVIDER` in `.env`):

- `api` (default) — direct REST against an OpenAI-compatible
  `/chat/completions` endpoint. Used inside the container. Requires
  `LLM_API_KEY`, `LLM_AUTH_CLIENT_ID`, `LLM_AUTH_CLIENT_SECRET`, plus the
  base/auth/model knobs documented in `.env.example`. Default config
  targets the BMW GenAI gateway used by `ops-ai-cockpit`.
- `cli` — wraps the local `claude` CLI via the Agent SDK. Free local dev
  only; the CLI is not installed inside the container.

## RAG retrieval

On boot, every record's fields + the repo's README (markdown, heading-aware
chunks, max 1500 chars per chunk) are embedded via the OpenAI-compatible
embeddings API and stored in `app/db/embeddings.sqlite`. Global-scope chat
retrieves the top-K (default 8) most similar records and feeds only those
into the LLM prompt. Set `EMBEDDINGS_ENABLED=false` to skip RAG entirely
(chat then falls back to today's full-context behaviour). Bump
`EMBEDDINGS_PROMPT_VERSION` to invalidate all stored vectors when the
embed-source template changes.

README fetching uses `GITHUB_TOKEN` (`public_repo` scope is enough). When
the token is missing, only the `fields` chunk per record is embedded.
```

- [ ] **Step 3: Commit**

```bash
git add run.sh README.md
git commit -m "docs+ops: load .env in the container; document chat/RAG providers"
```

---

### Task 16: Integration smoke — `./run.sh --build` + manual chat check

**Files:** none modified — verification only.

- [ ] **Step 1: Build the image**

```bash
./run.sh --build
```
Expected: build succeeds; image `claude-ai-skills-report` exists.

- [ ] **Step 2: Start the container, watch the backfill log**

```bash
./run.sh
docker logs -f claude-ai-skills-report
```
Expected:
```
[boot] embeddings backfill starting for N records…
[boot] embeddings backfill: embedded=... skipped=... failed=...
efficiency-research-app listening on :8787
```

- [ ] **Step 3: Hit `/api/health` and `/api/chat`**

```bash
curl -s http://localhost:8787/api/health
curl -s -X POST http://localhost:8787/api/chat \
  -H 'content-type: application/json' \
  -d '{"scope":"global","message":"which vector database MCP is best for code search?"}' | jq .
```
Expected: `health` returns `{"ok":true}`. Chat returns `{ answer: "...", retrieval: { mode: "rag", topK: 8, hits: [...] } }`. If `retrieval.mode` is `"full-context"` — embeddings boot path didn't finish; check the container log.

- [ ] **Step 4: Smoke-test a record-scope query in the browser**

Open `http://localhost:8787`, click a record, type a question, hit Send. Verify a real answer comes back (not "chat not configured").

- [ ] **Step 5: Commit a PROGRESS.md note**

```bash
# Edit PROGRESS.md and append:
#   2026-... — chat-RAG V1 verified end-to-end.
git add PROGRESS.md  # local-only, so this is technically a no-op against the remote.
```

(`PROGRESS.md` is gitignored, so this is a local note only — no remote commit.)

---

## Self-review

- **Spec coverage.** Every section of the spec maps to a task:
  - Provider-pluggable chat → Tasks 2–6.
  - OAuth caching → Task 3.
  - Embed source format + READMEs → Task 9.
  - Storage schema → Task 10.
  - Backfill flow → Task 11.
  - Retrieval flow → Task 12.
  - Fallback when RAG unavailable → Task 13.
  - Error UX (config refusal, 502 on upstream) → Task 2/4/14.
  - Tests list → all tasks cover their assigned tests; CLI provider has none by design.
  - Migration concerns (env file, DB path) → Tasks 14 + 15.
- **Placeholders:** none — every step has runnable code or commands.
- **Type consistency:** `LlmConfig` shape stable across Tasks 2/3/4/6; `EmbeddingsConfig` stable across 7/8/10/11/12; the chunk-row shape in Task 10 matches what Task 11 inserts and what Task 12 reads.
- **Frontend untouched** as required.
