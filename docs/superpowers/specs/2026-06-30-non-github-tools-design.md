# Design — Companion-App Category (non-GitHub tools)

Date: 2026-06-30
Status: Approved — ready for implementation plan
Brainstorm protocol: `2026-06-30-non-github-tools-brainstorm.md`

## Context

The catalogue today holds 143 GitHub repos in three categories
(`plugin-skill | mcp-server | token-tool`). Every augment / RAG /
sorting feature assumes the record's `url` is a github.com URL.

The user wants to extend the catalogue with **free tools that support
AI work but don't live primarily on GitHub** — Obsidian as the
prototypical example. Sub-classes include knowledge tools, local LLM
runners, AI-aware code editors, and AI dev plugins for IDEs.

Focus is preserved by sharp research topics, not by narrow categories:
"free PKM apps with AI/RAG plugin ecosystem" is sharp; "free AI tools"
is not.

## Decisions

1. **One new top-level category: `companion-app`.** Sub-classification
   stays in `use_cases` — the LLM picks tags during discover, the UI
   builds filters dynamically from whatever tags appear. No new schema
   field for sub-class.
2. **Optional `repo_url` schema field.** When set, drives the augment
   phase (stars/version/contributors) and the RAG-backfill (README
   chunks). When absent, those steps no-op for that record.
3. **`url` is now the canonical homepage** (Obsidian → obsidian.md). For
   pure-GitHub records, build-time fallback sets `repo_url = url` if it
   matches `github.com/...`.
4. **Discover + Verify prompts extended** so the LLM treats non-GitHub
   homepages as legitimate, but only when a free tier / open-source
   licence is explicit on the page.
5. **RAG: fields-chunk only for non-GitHub records.** No homepage scrape;
   YAGNI. Existing fields-only retrieval is already sharp.
6. **UI: header `Repo` → `Name`.** A small icon next to the link tells
   GitHub apart from homepage (Octocat vs Globe). DetailPanel mirrors.
7. **Seed first, run later.** Phase 1 implements the infra and inserts
   two hand-crafted seed records (Obsidian, Logseq) so we have test
   data. Phase 2 (separate, user-triggered) runs the full workflow
   against the four new topics.

## Schema

### `raw-records.json` (and downstream `report.json`)

Add **one optional field**:

```diff
{
  "id": "obsidian",
  "name": "Obsidian",
  "url": "https://obsidian.md",
+ "repo_url": "https://github.com/obsidianmd/obsidian-releases",
  "category": "companion-app",
  "stars": null,
  "stars_display": null,
  "version": null,
  "contributors": null,
  "description": "...",
  "efficiency_gain": "...",
  "sources": [...],
  "confidence": "high",
  "use_cases": ["knowledge-tool", "note-taking", "rag", "free"],
  "last_researched": "2026-06-30"
}
```

Rules:

- `repo_url` is `string | null`. When absent in `raw-records.json` it
  defaults to `null` in `report.json`, except when `url` matches
  `github.com/{owner}/{repo}` — then build-time copies `url → repo_url`
  (so the existing 143 records continue to feed the augment + RAG
  pipelines without an explicit migration).
- `category` enum grows to `plugin-skill | mcp-server | token-tool | companion-app`.

### `research-topics.yaml`

Header comment updated to allow the fourth category. Four new entries
(all weight 4):

```yaml
- topic: "Free PKM / Markdown-notes apps with AI/RAG plugin ecosystem (Obsidian, Logseq, Anytype, AppFlowy)"
  category: companion-app
  weight: 4

- topic: "Free local-LLM-runner desktop apps including mini-LLMs for local micro-tasks (LM Studio, Jan.ai, Ollama desktop, GPT4All, AnythingLLM)"
  category: companion-app
  weight: 4

- topic: "Free AI-aware code editors / standalone IDEs (Cursor free tier, Zed AI, Windsurf, Continue.dev standalone)"
  category: companion-app
  weight: 4

- topic: "Free AI dev-tools — VS Code / JetBrains / IDE AI plugins (Continue, Cline, Codeium free tier, Aider, Tabnine free, ProxyAI)"
  category: companion-app
  weight: 4
```

## Affected components

### `.claude/skills/efficiency-research/pipeline/research-pipeline.js`

Two prompt extensions inside the existing Workflow:

**Discover**:

> If the candidate is NOT primarily a GitHub repo (Obsidian, LM Studio,
> Cursor, …), set `url` to the canonical homepage. Optionally fill
> `repo_url` if a meaningful GitHub presence exists (release notes
> repo, plugin-list repo). Only return tools where a **free tier or
> open-source licence is explicit** on the homepage.

**Verify**:

> For non-github.com URLs, WebFetch the homepage and confirm:
> (1) product page is live, (2) free tier or open-source claim is
> explicit, (3) claimed capability matches the description. Drop
> entries that are paywalled with no free tier.

Schema in the workflow prompt grows by `repo_url: { type: ['string','null'] }`.

### `scripts/augment-github-meta.mjs`

Change `slugOf(rec)` to read `rec.repo_url || rec.url`. When neither
yields a github slug → skip this record (it stays null for
stars/version/contributors). No crash on companion-app records that
omit `repo_url`.

### `scripts/build-report.mjs`

- Add `'companion-app'` to `CATEGORIES`.
- Add a fourth title to `CATEGORY_TITLES`: `"Companion Apps"`.
- In `buildReport`, when threading the record through, derive
  `repo_url` with the fallback rule:

  ```js
  const repoUrl = r.repo_url ?? (matchesGithub(r.url) ? r.url : null);
  ```

- `renderMarkdown`: gracefully handle null version / contributors (they
  already render `—` today — verify with the new category).

### `app/server/embeddings/backfill.mjs`

Change `repoSlugFromRecord(rec)` to prefer `rec.repo_url` over `rec.url`.
Effect: companion-app records without a GitHub repo get only the
fields-chunk, no README fetch. Already the de-facto behaviour because
`fetchReadme` fails open on non-github URLs; this change makes it
intentional.

### `app/server/chat.mjs`

No code change required. `recordDetail` already uses `r.version` /
`r.contributors` with `null`-safe `??` checks (added in the previous
slice). `recordLine` also.

### `app/web/types.ts`

```diff
export interface Rec {
  id: string;
  name: string;
  url: string;
+ repo_url: string | null;
  category: "plugin-skill" | "mcp-server" | "token-tool" | "companion-app";
  stars: number | null;
  ...
}
```

### `app/web/columns.tsx`

- Header `Repo` → `Name`.
- Name cell: render a small icon before the link.
  - `isGithub(url)` → GitHub octocat icon (existing lucide-react or
    inline SVG).
  - else → Globe icon (lucide `globe` or inline SVG).
- Tooltip: "GitHub repo" / "Homepage".

### `app/web/DetailPanel.tsx`

- Same icon next to the linked title.
- If `record.repo_url` is set AND distinct from `record.url`, render an
  extra small line: `↗ Repo: github.com/{owner}/{name}` linking to it.

## Seed data

Two hand-curated entries added directly to `data/raw-records.json`
during Phase 1 implementation, BEFORE any new workflow run:

**Obsidian — non-GitHub primary**:

```json
{
  "name": "Obsidian",
  "url": "https://obsidian.md",
  "repo_url": "https://github.com/obsidianmd/obsidian-releases",
  "category": "companion-app",
  "stars": null,
  "stars_display": null,
  "description": "Local-first Markdown knowledge base with a thriving plugin ecosystem that includes AI/RAG plugins (Smart Connections, Copilot, Text Generator) and Anthropic-API-compatible chat plugins.",
  "efficiency_gain": "Acts as Claude's external memory: an indexed personal knowledge base the user can curate manually and feed into RAG with a plugin.",
  "sources": ["https://obsidian.md", "https://github.com/obsidianmd/obsidian-releases"],
  "confidence": "high",
  "use_cases": ["knowledge-tool", "note-taking", "rag", "free"]
}
```

**Logseq — GitHub-native companion-app (contrast case)**:

```json
{
  "name": "logseq/logseq",
  "url": "https://github.com/logseq/logseq",
  "repo_url": "https://github.com/logseq/logseq",
  "category": "companion-app",
  "stars": null,
  "stars_display": null,
  "description": "Open-source local-first outliner and PKM tool with a graph view. Plugin ecosystem includes Smart Connections-style AI helpers.",
  "efficiency_gain": "Offline-friendly Markdown knowledge base; same RAG-feeding role as Obsidian but fully open-source.",
  "sources": ["https://github.com/logseq/logseq"],
  "confidence": "high",
  "use_cases": ["knowledge-tool", "note-taking", "rag", "free"]
}
```

After insertion, the existing `npm run report:augment` fills in version
and contributors for both (Logseq fully; Obsidian only what the
releases repo offers).

## Tests

- `build-report.test.mjs`: covers
  - `companion-app` as a valid category;
  - record without `repo_url` and non-github `url` keeps `repo_url=null`;
  - record without `repo_url` but with github `url` gets the fallback.
- `augment-github-meta.mjs`: smoke (manual or unit) — record without
  any github reference is skipped without error.
- Existing 73 backend tests + 15 skill tests must stay green.

## Out of scope (V1)

- Docs-site scraping for RAG chunks (Q4 decision).
- Pricing tier as a structured field (`use_cases: ["free"]` is enough).
- AI-search frontends (Perplexity / Phind / Kagi) — user explicitly
  declined.
- VS Code / JetBrains marketplace install counts as a separate metric
  (the topic 4 plugin-list returns will mostly resolve to their GitHub
  repos anyway, where contributors-count is the truer signal).

## Phasing

| Phase | Trigger | Work |
| --- | --- | --- |
| **1 — Infra + seed** | Now | Schema, pipeline-prompt updates, build-report, augment, RAG-backfill, UI icons, types, tests, two seed records. Re-augment, rebuild report, restart container. |
| **2 — Real research** | User triggers later | Run `research-pipeline.js` with the extended YAML, get 30-40 new companion-app records, merge additively into `raw-records.json`, augment, rebuild. |

Phase 1 deliverable: a working catalogue that includes Obsidian + Logseq
under the new `companion-app` category, augment idempotent, UI renders
the homepage icon, container boots cleanly with the new schema.

## Risk

- The fallback rule (`repo_url = url` when `url` is github) is implicit
  build-time magic. Future readers might wonder why `raw-records.json`
  has no `repo_url` field for the original 143. Documented in the
  build-report header comment.
- Schema mismatch between `raw-records.json` (where `repo_url` may be
  absent) and `report.json` (where it's always present, populated
  by the fallback). Acceptable because clients only read `report.json`.
