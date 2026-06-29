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

The chat backend uses `askClaude()` (`app/server/claude.mjs`) — Claude Agent SDK over the
Pro/Max subscription, **no `ANTHROPIC_API_KEY`** (keeping it unset avoids
pay-per-token billing).

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
