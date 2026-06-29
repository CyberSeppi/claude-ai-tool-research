# Design — Efficiency-Research Skill + Research Web-App

Date: 2026-06-29
Status: Awaiting user review

## Vision

Replace the current Agent-SDK PoC with a recurring research system in two parts:

1. **`efficiency-research` skill** (Claude CLI, runs in this workspace) — robustly researches the best GitHub repos that boost Claude Code efficiency (plugins/skills, MCP servers, token/research tools), scans the local system to mark which are already installed, and emits a machine-readable `data/report.json` plus a human `data/report.md`.
2. **Research web-app** (single container) — imports `report.json`, shows records in a modern sortable/filterable/full-text-searchable table, lets the user flag records as interesting, and provides chat (per-record context + global compare/rate) backed by Claude via the existing subscription Agent-SDK path.

`report.json` is the contract between the two parts. Build order: **skill first**, run it once to produce real data, then build the app against it.

## Decisions (from brainstorming)

- Research runs in the Claude CLI as a skill — **not** inside the container. The app only imports + refreshes.
- The skill must also scan installed skills/plugins/MCP and record which report entries are already present.
- Chat is **both** per-record (context = one skill) **and** global (across all records, able to compare and rate skills against each other).
- Auth: chat reuses the `ask.ts` Agent-SDK-over-Pro/Max-subscription pattern (no API key). Container mounts host `~/.claude` read-only.
- UI skill: `frontend-design` (the `ui-ux-pro-max` skill is not installed in this environment; UX rules applied manually).

---

## Part 1 — `efficiency-research` skill (THIS round)

Location: `.claude/skills/efficiency-research/SKILL.md` (project-level skill).

### Behavior when invoked

1. **Research phase** — deep, multi-source web research on GitHub repos that boost Claude Code efficiency, across three categories:
   - `plugin-skill` — Claude Code plugins, skills, subagent collections, marketplaces.
   - `mcp-server` — MCP servers (research access, docs, web search, automation).
   - `token-tool` — token-savings / research-access tools.
   Method: decompose into search angles → fan-out web search → fetch primary sources → **adversarially verify star counts and capability claims against the repo itself** (a refuted star count is dropped/flagged, not published). Reuse the `deep-research` skill if available; otherwise perform the steps directly with web search + fetch.

2. **System-scan phase** — enumerate what is already installed locally:
   - Skills: `~/.claude/skills/`, project `.claude/skills/`, plugin-bundled skills under `~/.claude/plugins/cache/*/*/skills/`.
   - Plugins / marketplaces: `~/.claude/plugins/` (config + marketplaces + cache).
   - MCP servers: `~/.claude.json`, project `.mcp.json`, settings files (configured MCP server entries).
   Produce a set of installed identifiers (repo slug, name, and/or URL).

3. **Cross-reference** — for each researched record, set `installed=true` when it matches an installed item; capture `installed_path` and `installed_via` (which dir/marketplace).

4. **Emit** — write `data/report.json` (schema below) and `data/report.md` (human-readable table, like the existing `claude-efficiency-repos.md`). Each run regenerates both; every record carries a `last_researched` date.

### Robustness requirements

- Tolerate web/tool failures: continue with partial results, never crash the run.
- Dedupe records by canonical repo URL.
- Verify star counts against the primary repo; mark `confidence` per record.
- Tolerate missing local directories during the system scan (treat as "none found").
- Star counts are time-sensitive snapshots — always stamp `generated_at` / `last_researched`.

### `report.json` schema (the contract)

```json
{
  "generated_at": "2026-06-29T08:00:00Z",
  "query": "Best GitHub repos for boosting Claude Code efficiency …",
  "records": [
    {
      "id": "anthropics-skills",
      "name": "anthropics/skills",
      "url": "https://github.com/anthropics/skills",
      "category": "plugin-skill",
      "stars": 156376,
      "stars_display": "~156k",
      "description": "Official Agent Skills …",
      "efficiency_gain": "Dynamic load saves context tokens …",
      "installed": true,
      "installed_path": "/home/julian-prentl/.claude/plugins/cache/…",
      "installed_via": "marketplace:claude-plugins-official",
      "sources": ["https://github.com/anthropics/skills"],
      "confidence": "high",
      "last_researched": "2026-06-29"
    }
  ]
}
```

- `id`: stable slug derived from `owner/repo` (lowercase, `/`→`-`). Used by the app to key flags so they survive re-imports.
- `category`: one of `plugin-skill | mcp-server | token-tool`.
- `stars`: integer when known, else null; `stars_display`: short label.
- `installed*`: null/false when not found locally.

---

## Part 2 — Research web-app (NEXT round, captured here for the contract)

Single container; one Node service serves the API and the built frontend.

- **Stack:** React + Vite + TypeScript frontend; Node + Hono backend; SQLite (better-sqlite3).
- **Data flow:** `data/report.json` (mounted read-only) → `POST /api/refresh` upserts records into SQLite. Flags live in a separate table keyed by record `id`, so re-import never clobbers them.
- **Table:** TanStack Table — column sort, per-column filter, global full-text search. Columns: name, category, stars, installed badge, flagged badge.
- **Row click → side panel:** full description, efficiency gain, sources, installed/flag badges, **★ Flag interesting** toggle, per-record **chat**.
- **Chat:**
  - Per-record: context = the selected record.
  - Global: context = all (or a selected subset of) records; able to **compare and rate** skills against each other.
  - Backend `POST /api/chat` takes `{ scope: "record"|"global"|"selection", ids?, message }` → builds context → calls `askClaude` (Agent SDK / subscription).
- **Endpoints:** `GET /api/records`, `POST /api/refresh`, `POST /api/records/:id/flag`, `POST /api/chat`.
- **Container:** Dockerfile + docker-compose. Volumes:
  - `./data` → report mount **from this project directory** (`data/report.json` + `data/report.md` produced by the skill); the app reads it, so editing/regenerating the report on the host is immediately visible to the container.
  - `./db` (sqlite persist), `~/.claude` (ro, chat auth).
  - No `ANTHROPIC_API_KEY` set inside (would force pay-per-token).
- **Runner script** (`run.sh` at repo root) to start the app:
  - `./run.sh` — start the container (compose up) using the existing image.
  - `./run.sh build` — rebuild the image first, then start (`compose up --build`).
  - Also accept `./run.sh down` / `./run.sh logs` for stop + tail. Script is the single entry point so the user never types raw docker/compose commands.

### Cleanup (start of app round)

- Remove `ask.ts` CLI bits and the old `README.md`.
- **Keep** the `askClaude()` Agent-SDK logic (chat reuses it) and `claude-efficiency-repos.md` as seed/reference.

---

## Out of scope (YAGNI)

- Multi-user / auth / accounts (single-user local app).
- Scheduled/automatic research from inside the app (research is a manual CLI skill run).
- Postgres or any external DB (SQLite is enough for single-user).
- Editing/curating records in the UI beyond flagging.
