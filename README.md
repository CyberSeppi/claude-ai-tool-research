# Claude AI Skills Report

Recurring research into the best GitHub repos that boost Claude Code efficiency
(plugins/skills, MCP servers, token/research tools) — plus a containerized web app
to browse, filter, flag, and chat about the results.

Two parts:

1. **`efficiency-research` skill** (`.claude/skills/efficiency-research/`) — runs in
   the Claude CLI. Researches the top repos, scans the local system to mark which are
   already installed, and writes `data/report.json` + `data/report.md`.
2. **Research web app** (container, *next round*) — imports `data/report.json`, shows
   a sortable/filterable/full-text-searchable table, flag-as-interesting per record,
   and chat (per-record + global compare/rate) via the Claude subscription path.

## Docs

- Design / spec: `docs/superpowers/specs/2026-06-29-skill-research-and-app-design.md`
- Implementation plan (skill): `docs/superpowers/plans/2026-06-29-efficiency-research-skill.md`

## Run the research skill

```bash
npm install                 # one-time
npm run test:skill          # helper-script tests
npm run research:build      # rebuild report.json + report.md from data/raw-records.json
```

## Chat backend

Two providers (pick via `LLM_PROVIDER` in `.env`):

- `api` (default) — direct REST against an OpenAI-compatible
  `/chat/completions` endpoint. Works inside the container. Requires
  `LLM_API_KEY`, `LLM_AUTH_CLIENT_ID`, `LLM_AUTH_CLIENT_SECRET` plus the
  base/auth/model knobs documented in `.env.example`. The default config
  targets the BMW GenAI gateway used by `ops-ai-cockpit`.
- `cli` — wraps the local `claude` CLI via the Agent SDK (Pro/Max
  subscription, no API key). Free local dev only — the CLI is not
  installed inside the Docker container.

The chat backend lives under `app/server/llm/`:
`config.mjs` → `oauth.mjs` (M2M token cache) → `provider-api.mjs` /
`provider-cli.mjs` → `index.mjs` (selector). Mocked-fetch tests run via
`node --test app/server/llm/*.test.mjs`.

## RAG retrieval

*Coming in a later slice.* Today's `scope=global` chat stuffs all
records into the context. The follow-up will embed every record's
fields + the repo's README (markdown-chunked) at boot, store the
vectors in `app/db/embeddings.sqlite`, and let global chat retrieve the
top-K most similar records. Set `EMBEDDINGS_ENABLED=false` to keep the
fallback behaviour. Bump `EMBEDDINGS_PROMPT_VERSION` to invalidate
stored vectors when the embed-source template changes. README fetching
uses `GITHUB_TOKEN` (`public_repo` scope is enough). Spec:
`docs/superpowers/specs/2026-06-29-chat-rag-design.md`.

## Run the web app (container)

Single container, plain `docker run` (no compose):

```bash
./run.sh --build   # build image, then start  (http://localhost:8787)
./run.sh           # start with existing image
./run.sh stop      # stop + remove container
```

Host port via `APP_PORT` (default 8787), e.g. `APP_PORT=8788 ./run.sh`. Logs: `docker logs -f claude-ai-skills-report`.

The container runs as your host user (`--user $(id -u):$(id -g)`), so any files it writes into the bind-mounts stay host-owned — no more root-owned `flags.json` or stale OAuth token cache.

Mounts: `./data` → `/data` (report, read-only), `./app/db` → `/db` (**flags persist here as `flags.json`**), `~/.claude` → `/home/app/.claude` (writable — chat auth + OAuth token cache; `HOME=/home/app`; no API key, uses your Pro/Max subscription).

The app reads `data/report.json` live on each request and renders it; the **Refresh** button re-reads it after you regenerate the report.
