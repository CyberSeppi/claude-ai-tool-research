# Claude AI Skills Report

Recurring research into the best GitHub repos that boost Claude Code
efficiency (plugins/skills, MCP servers, token/research tools), plus a
containerised web app to browse, filter, flag, and chat about the results.

Two parts:

1. **`efficiency-research` skill** (`.claude/skills/efficiency-research/`)
   — runs in the Claude CLI. Researches the top repos, scans the local
   system to mark which are already installed, and writes
   `data/report.json` + `data/report.md`.
2. **Research web app** — imports `data/report.json`, shows a
   sortable/filterable/full-text-searchable table, flag-as-interesting per
   record, and chat (per-record + global compare/rate) backed by Claude.

## Docs

- Design / spec: `docs/superpowers/specs/2026-06-29-skill-research-and-app-design.md`
- Chat + RAG design: `docs/superpowers/specs/2026-06-29-chat-rag-design.md`
- Implementation plan (skill): `docs/superpowers/plans/2026-06-29-efficiency-research-skill.md`
- Implementation plan (chat + RAG): `docs/superpowers/plans/2026-06-29-chat-rag-implementation.md`

## Run the research skill

```bash
npm install                 # one-time
npm run test:skill          # helper-script tests
npm run research:build      # rebuild report.json + report.md from data/raw-records.json
```

## Chat backend

One provider: a direct REST call to an OpenAI-compatible
`/chat/completions` endpoint. Whatever URL you put in
`LLM_API_BASE_URL` is where the app talks; defaults to
`https://api.anthropic.com/v1`. Required env vars are documented in
`.env.example`.

### Setup A — Anthropic API key (recommended)

Get an API key at https://console.anthropic.com, then set:

```env
LLM_API_BASE_URL=https://api.anthropic.com/v1
LLM_API_KEY=sk-ant-...
LLM_MODEL=claude-sonnet-4-6
```

Billed per token to your Anthropic account. Works inside the container.

### Setup B — Claude Pro / Max / Team subscription (local dev only)

The app speaks the OpenAI wire format; Pro/Max subscriptions authenticate
the official `claude` CLI, not direct API calls. To use a subscription
you need a **local bridge process** that:

1. Listens on a port on your host (e.g. `:11434`).
2. Accepts OpenAI-shaped `/chat/completions` requests.
3. Forwards them through `claude` CLI (or its equivalent) using your
   Pro/Max OAuth session in `~/.claude/`.

Then point this app at the bridge:

```env
LLM_API_BASE_URL=http://host.docker.internal:11434/v1
LLM_API_KEY=anything-non-empty
```

`run.sh` adds `--add-host=host.docker.internal:host-gateway` so a host
service is reachable from the container by that name. The bridge handles
the Anthropic↔OpenAI translation; this app stays vendor-neutral.

Bridges that work (community projects, not endorsed):

- [claude-bridge](https://github.com/badlogic/lemmy/tree/main/apps/claude-bridge) — bridges the OpenAI API to Claude Code's Pro/Max session
- [claude-code-router](https://github.com/musistudio/claude-code-router) — routes `claude` CLI through configurable backends
- [LiteLLM](https://github.com/BerriAI/litellm) — OpenAI-shape proxy over many providers

> [!CAUTION]
> Using your Pro / Max / Team subscription as the backend of a
> **publicly-deployed** or **multi-user** application would violate
> Anthropic's terms. Those plans are licensed for personal interactive
> use by the subscriber — wiring them into a service other people chat
> with is "providing access to another person".
>
> See Anthropic's [Usage Policy](https://www.anthropic.com/legal/aup),
> [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), and
> the explicit Claude Code subscription-vs-API guidance in
> [Anthropic's Help Center](https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan).
>
> Subscription routing is for **local solo development only**. Any
> deployed / shared instance must use Setup A (API key).

### Setup C — Corporate / internal gateway with OAuth M2M

Some internal gateways require an additional machine-to-machine OAuth
client-credentials flow on top of the API key:

```env
LLM_API_BASE_URL=https://your-gateway.example.com/v1
LLM_API_KEY=<gateway-api-key>
LLM_AUTH_TOKEN_URL=https://your-iam.example.com/.../access_token
LLM_AUTH_CLIENT_ID=<client-id>
LLM_AUTH_CLIENT_SECRET=<client-secret>
LLM_AUTH_SCOPE=<scope>
```

When `LLM_AUTH_TOKEN_URL` is set, the app exchanges client_id +
client_secret for a bearer token before each call (cached, refreshed
~30 s before expiry). Leave the block empty for Setup A / Setup B.

## Implementation

The chat backend lives under `app/server/llm/`:
`config.mjs` → `oauth.mjs` (M2M token cache) → `provider-api.mjs` →
`index.mjs`. Mocked-fetch tests:
`node --test app/server/llm/*.test.mjs`.

## RAG retrieval

*Coming in a later slice.* Today's `scope=global` chat stuffs all records
into the context. The follow-up will embed every record's fields + the
repo's README (markdown-chunked) at boot, store the vectors in
`app/db/embeddings.sqlite`, and let global chat retrieve the top-K most
similar records. Set `EMBEDDINGS_ENABLED=false` to keep the fallback
behaviour. Bump `EMBEDDINGS_PROMPT_VERSION` to invalidate stored vectors
when the embed-source template changes. README fetching uses
`GITHUB_TOKEN` (`public_repo` scope is enough). Spec:
`docs/superpowers/specs/2026-06-29-chat-rag-design.md`.

## Run the web app (container)

Single container, plain `docker run` (no compose):

```bash
./run.sh --build   # build image, then start  (http://localhost:8787)
./run.sh           # start with existing image
./run.sh stop      # stop + remove container
```

Host port via `APP_PORT` (default 8787), e.g. `APP_PORT=8788 ./run.sh`.
Logs: `docker logs -f claude-ai-skills-report`.

The container runs as your host user (`--user $(id -u):$(id -g)`), so
any files it writes into the bind-mounts stay host-owned.

Mounts: `./data` → `/data` (report, read-only), `./app/db` → `/db`
(flags persist here as `flags.json`). `HOME=/home/app` inside the
container.

The app reads `data/report.json` live on each request and renders it;
the **Refresh** button re-reads it after you regenerate the report.
