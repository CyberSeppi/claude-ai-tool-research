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

Two providers, picked via `LLM_PROVIDER` in `.env`:

### Provider: `api` (default — recommended)

Direct REST against an OpenAI-compatible `/chat/completions` endpoint.
Works inside the Docker container. Reaches whatever URL you put in
`LLM_API_BASE_URL`; defaults to `https://api.anthropic.com/v1`.

- Anthropic direct: set `LLM_API_KEY=sk-ant-…` and pick a `LLM_MODEL`.
- Internal corporate / cloud gateway: set the base URL plus the optional
  `LLM_AUTH_CLIENT_ID` / `LLM_AUTH_CLIENT_SECRET` / `LLM_AUTH_TOKEN_URL` /
  `LLM_AUTH_SCOPE` to enable the OAuth M2M client-credentials flow.

All knobs are documented in `.env.example`.

### Provider: `cli` (local development only)

Wraps the bundled `claude` CLI through `@anthropic-ai/claude-agent-sdk`.
Three auth modes are supported — pick one in `.env`; the app refuses to
start if none of them resolve:

| Mode | `.env` settings | Notes |
|---|---|---|
| **A — Anthropic API key** | `ANTHROPIC_API_KEY=sk-ant-…` | Simplest. Talks directly to `api.anthropic.com`. Billed per-token. |
| **B — Local Anthropic-compat router** | `ANTHROPIC_BASE_URL=http://host.docker.internal:<port>`, `ANTHROPIC_AUTH_TOKEN=<router-token>` | For CCR, litellm, claude-bridge, etc. running on the host. `run.sh` adds `--add-host=host.docker.internal:host-gateway` automatically. |
| **C — Mounted Pro/Max OAuth session** | (no env vars) | Run `claude /login` on the host first. `run.sh` bind-mounts `~/.claude/` + `~/.claude.json` so the in-container CLI inherits the Pro/Max session. |

> [!CAUTION]
> **Using `LLM_PROVIDER=cli` in a publicly-deployed or shared application
> would violate Anthropic's terms.** A Claude Pro / Max / Team
> subscription is licensed for personal interactive use by the
> subscriber. Wiring that subscription into a service that other people
> chat with — even read-only — is "providing access to another person".
> See Anthropic's [Usage Policy](https://www.anthropic.com/legal/aup),
> [Consumer Terms](https://www.anthropic.com/legal/consumer-terms), and
> the explicit Claude Code subscription-vs-API discussion in [Anthropic's
> Help Center](https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan).
>
> Keep this provider for **local solo development only**. For any
> deployed / shared instance, use `LLM_PROVIDER=api` with an API key
> billed to you or your organisation.

When set, `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` are forwarded
into the container so the bundled CLI can talk to a service on the
host (`http://host.docker.internal:<port>`) — useful for SSH tunnels or
local routers.

## Implementation

The chat backend lives under `app/server/llm/`:
`config.mjs` → `oauth.mjs` (M2M token cache) → `provider-api.mjs` /
`provider-cli.mjs` → `index.mjs` (selector). Mocked-fetch tests:
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
(flags persist here as `flags.json`), `~/.claude` →
`/home/app/.claude` + `~/.claude.json` → `/home/app/.claude.json`
(only used when `LLM_PROVIDER=cli`; `HOME=/home/app` inside the
container).

The app reads `data/report.json` live on each request and renders it;
the **Refresh** button re-reads it after you regenerate the report.
