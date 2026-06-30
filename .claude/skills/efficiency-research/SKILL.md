---
name: efficiency-research
description: Research the best GitHub repos for boosting Claude Code efficiency (plugins/skills, MCP servers, token/research tools), augment with GitHub metadata (version, contributors), and write data/report.json + data/report.md. Use when the user wants to (re)run the Claude-efficiency repo research or refresh the report.
---

# Efficiency Research

Produce a fact-checked report of the best GitHub repos that boost
Claude Code efficiency. Output: `data/report.json` (machine-readable,
the app reads it) + `data/report.md` (human-readable).

The data is produced in **three phases**:

1. **Research** (Claude — LLM) — fans out subagents per topic from
   `research-topics.yaml`, finds repos, verifies stars, classifies
   `use_cases`. Writes `data/raw-records.json`.
2. **Augment** (no LLM) — calls the GitHub REST API for each record to
   fill in `version` (latest release tag) and `contributors` (exact
   count). Writes back to `data/raw-records.json`.
3. **Build** (no LLM) — validates schema, dedupes by id, groups for
   Markdown, writes `data/report.{json,md}`.

## Automated pipeline (recommended)

Phase 1 runs via the Workflow tool (from the repo root):

```
Workflow({ scriptPath: ".claude/skills/efficiency-research/pipeline/research-pipeline.js" })
```

The workflow reads `research-topics.yaml`, researches each topic, dedupes,
verifies stars against GitHub, and writes `data/raw-records.json`.

Then run phase 2 + 3 from the shell:

```bash
npm run report:augment   # GitHub REST: fill in version + contributors
npm run report:build     # validate + emit data/report.{json,md}
```

If the Workflow tool is unavailable, follow the manual steps below for
phase 1 — they describe exactly what the workflow automates.

## Phase 1 — Research (manual fallback)

1. **Read the topic list.** Read `research-topics.yaml` at the project root — a
   user-editable list of research points, each with a `category` and a `weight`
   (1 = minor … 5 = must-have). Research every topic; give higher-weighted topics
   more effort and more candidates, and let weight inform ranking.

2. **Research.** For each topic, find the top GitHub repos in its `category`
   (`plugin-skill` | `mcp-server` | `token-tool`). Prefer the `deep-research`
   skill if available; else fan out web searches, fetch each candidate's GitHub
   page, and **verify the star count and the headline capability against the
   repo itself** before including it. Drop any repo whose stars or claims you
   cannot verify.

3. **Write raw records.** Save findings to `data/raw-records.json` — a JSON
   array where each item has: `name` (`owner/repo`), `url`, `category` (one of
   the three), `stars` (int), `stars_display` (e.g. `~58k`), `description`,
   `efficiency_gain`, `sources` (string[]), `confidence` (`high|medium|low`),
   and **`use_cases`** (non-empty array of lowercase tags).

   **`use_cases` classification** (multi-tag, dynamic). Assign every tag that
   genuinely applies, based on description + efficiency_gain + category.
   Recommended vocabulary (reuse consistently): `research`, `development`,
   `token-efficiency`, `brainstorming`, `automation`, `docs`, `debugging`,
   `ui-design`, `rag`. If none fits, mint a new concise lowercase-hyphen tag
   (e.g. `security`) — but avoid near-duplicates. The app's use-case filter
   builds dynamically from whatever tags appear in the data.

   Do NOT write `version` or `contributors` from the LLM — phase 2 fills those
   from GitHub's REST API.

## Phase 2 — Augment (GitHub REST, deterministic)

```bash
npm run report:augment
```

This invokes `scripts/augment-github-meta.mjs`, which:

- Reads `data/raw-records.json`.
- For each record, calls `GET /repos/{owner}/{repo}/releases/latest` (falls
  back to the most recent tag if no release exists) to set `version`.
- Calls `GET /repos/{owner}/{repo}/contributors?per_page=1&anon=true` and
  parses the `Link` header to set the exact contributor count.
- Skips records that already carry both fields; pass `--force` to re-fetch.
- Honours `HTTPS_PROXY` / `NO_PROXY`.

Requires `GITHUB_TOKEN` in `.env` (any PAT with the default public scopes
is enough). With concurrency=8 it runs ~30 s for 143 records.

## Phase 3 — Build (deterministic)

```bash
npm run report:build
```

Runs `scripts/build-report.mjs` which:

- Reads `data/raw-records.json`.
- Dedupes by canonical id, validates the schema, threads `version` +
  `contributors` through to the output.
- Writes `data/report.json` and `data/report.md`.

## Notes

- `research-topics.yaml` is the control surface — edit it to add/remove/
  reprioritise topics. Only the LLM phase reads it; the helper scripts
  do not parse YAML.
- Schema reference: `docs/superpowers/specs/2026-06-29-skill-research-and-app-design.md`.
- Helper-script tests: `npm run test:skill`.
- The container the app runs in reads `data/report.json` live on every
  request — no rebuild needed.

## Note on user-curated entries

The app's UI has its own "+ Add Tool" mechanism for entries the
crawler misses. Those records live in `app/db/seeds.json` and are
merged in-memory by the backend on every API request. They do not
appear in `data/raw-records.json` — the workflow's view of the world
is unchanged. See `docs/superpowers/specs/2026-06-30-user-curated-seeds-design.md`
for the design.
