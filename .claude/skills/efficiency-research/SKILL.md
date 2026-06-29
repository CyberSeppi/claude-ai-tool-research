---
name: efficiency-research
description: Research the best GitHub repos for boosting Claude Code efficiency (plugins/skills, MCP servers, token/research tools), mark which are already installed locally, and write data/report.json + data/report.md. Use when the user wants to (re)run the Claude-efficiency repo research or refresh the report.
---

# Efficiency Research

Produce a fact-checked, install-aware report of the best GitHub repos that boost
Claude Code efficiency. Output: `data/report.json` (machine-readable) + `data/report.md`.

## Automated pipeline (recommended)

Run the full discover → classify → verify cycle in one shot via the committed
Workflow (requires the Workflow tool; run from the repo root):

```
Workflow({ scriptPath: ".claude/skills/efficiency-research/pipeline/research-pipeline.js" })
```

It reads `research-topics.yaml`, researches each topic (assigning `use_cases`),
dedupes, verifies star counts against GitHub, and writes `data/raw-records.json`.
Then run `npm run research:build` to scan local installs, mark `installed`,
validate, and write `data/report.json` + `data/report.md`.

If the Workflow tool is unavailable, follow the manual steps below — they describe
exactly what the pipeline automates.

## Steps

1. **Read the topic list.** Read `research-topics.yaml` at the project root — a
   user-editable list of research points, each with a `category` and a `weight`
   (1 = minor … 5 = must-have). Research every topic; give higher-weighted topics
   more effort and more candidates, and let weight inform ranking in the report.

2. **Research.** For each topic, find the top GitHub repos in its `category`
   (`plugin-skill` | `mcp-server` | `token-tool`). Prefer the `deep-research` skill if
   available; else fan out web searches, fetch each candidate's GitHub page, and
   **verify the star count and the headline capability against the repo itself**
   before including it. Drop any repo whose stars or claims you cannot verify.

3. **Write raw records.** Save findings to `data/raw-records.json` — a JSON array
   where each item has: `name` (`owner/repo`), `url`, `category` (one of the three),
   `stars` (int), `stars_display` (e.g. `~58k`), `description`, `efficiency_gain`,
   `sources` (string[]), `confidence` (`high|medium|low`), and **`use_cases`** (a
   non-empty array of 1+ lowercase tags — a finding may carry several). Do NOT add
   install fields.

   **`use_cases` classification** (multi-tag, dynamic). Assign every tag that genuinely
   applies, based on description + efficiency_gain + category. Recommended vocabulary
   (reuse consistently): `research`, `development`, `token-efficiency`, `brainstorming`,
   `automation`, `docs`, `debugging`, `ui-design`. If none fits, you MAY mint a new
   concise lowercase-hyphen tag (e.g. `security`) — but avoid near-duplicates. The app
   builds its use-case filter dynamically from whatever tags appear in the data.

4. **Build the report.** Run `npm run research:build`. This scans the local system
   for installed skills/plugins/MCP servers, marks each record `installed` with
   `installed_path` / `installed_via`, dedupes by id, validates the schema, and
   writes `data/report.json` + `data/report.md`.

5. **Report back.** Summarize counts (total, installed vs. not, per category) and
   note that star counts are time-sensitive snapshots.

## Notes

- `research-topics.yaml` (repo root) is the control surface: edit it to add, remove,
  or reprioritise what gets researched. Only this skill reads it (LLM-side); the
  helper scripts never parse it, so no YAML dependency is introduced.
- Schema + matching rules: see `docs/superpowers/specs/2026-06-29-skill-research-and-app-design.md`.
- Helper scripts live in `scripts/`; run their tests with `npm run test:skill`.
- Never set `ANTHROPIC_API_KEY` — research runs over the subscription path.
