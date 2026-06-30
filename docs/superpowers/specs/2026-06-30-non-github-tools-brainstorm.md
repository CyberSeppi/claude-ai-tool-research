# Brainstorm protocol — Catalogue tools beyond GitHub repos

Date: 2026-06-30
Status: Live transcript — captures questions, answers, options proposed
and the reasoning behind each. The final design spec is a separate file:
`2026-06-30-non-github-tools-design.md` (written after this protocol
reaches a stable answer set).

## Premise

Current scope: the tool catalogues 143 GitHub repos in three categories
(`plugin-skill | mcp-server | token-tool`). Augment phase calls GitHub
REST for `version` + `contributors`. RAG chunks fields + README (README
only exists for GitHub repos). UI columns: Repo · Category · Stars ·
Version · Contributors · Use-cases · Description.

User wants to expand this so non-GitHub items can be catalogued — they
named **Obsidian** as an example. The brainstorm decides:

1. What classes of non-GitHub tools are in scope?
2. Where does their metadata come from?
3. How do they coexist with the GitHub records in storage, UI, RAG?

---

## Q&A — running log

### Q1 — Welche Klassen von Tools?

**Asked:** (multi-select question with 4 options — Standalone apps,
Browser/IDE extensions, Web-services, Paid tools.)

**User redirected the scope:** the constraint isn't really "GitHub yes/no";
it's narrower:

- Tools must be **free**.
- Tools should **support AI work** — token saving, RAG, AI dev
  in general.
- Obsidian is the prototypical example.
- Worry: a research run should stay **focused**; how to fit this in
  without diluting the result?

### My response — where focus actually comes from

Focus is a property of **research-topic sharpness**, not of category
breadth.

- "Find me free AI tools" → broad, useless.
- "Find me free Markdown PKM apps with AI/RAG plugin ecosystems" → sharp.

So the design question is: how do we add a *home* in the schema for
non-GitHub free tools, without weakening the topic-level focus?

### Three approaches I proposed

**A — Single sweeper category `companion-app`.**
One bucket for everything that isn't a Claude-Code-specific
plugin/MCP/token-tool. Differentiate via `use_cases` tags.
Pros: minimal schema change. Cons: category gets broad, less semantic
discrimination.

**B — Several specific new categories.**
`knowledge-tool` (Obsidian, Logseq), `local-llm` (LM Studio, Jan),
`ai-editor` (Cursor, Zed-AI), `ai-search` (Perplexity, Phind).
Pros: each category is sharp; filter UX gets crisp. Cons: schema
explosion every time we discover a new class.

**C — Hybrid (recommended).** One new category + sharp topics:

- One new `category` value: `companion-app` (or better name).
- 3–4 **sharp** new entries in `research-topics.yaml`, e.g.:
  - "Free Markdown/PKM apps with AI/RAG plugin ecosystem
     (Obsidian, Logseq, Anytype)"
  - "Free local-LLM-runner desktop apps (LM Studio, Jan.ai, GPT4All)"
  - "Free AI-aware code editors with Anthropic support
     (Cursor free tier, Zed AI)"
- Schema change: add an OPTIONAL `repo_url` field. The existing `url`
  becomes the canonical homepage (Obsidian → obsidian.md, a GitHub repo
  → its repo URL).
- Augment-phase logic branches on `repo_url`: present → GitHub REST as
  today; absent → version/contributors stay null, or the LLM research
  phase fills `version` manually from the homepage.
- `use_cases` tags handle within-category differentiation
  (`note-taking`, `local-llm`, `voice`, `ai-editor`, …).

Pros: focus preserved by topic sharpness, category surface stays slim,
schema change is minimal. Cons: one category name now denotes *form*
("companion app") rather than *function* ("what it does for Claude") —
mildly inconsistent with the existing three categories.

**Recommendation: C.**

### Q1 — Decision

**User accepted C** with refinement:

- Top-level category: `companion-app` ✓
- Below the category we still want **dynamic sub-classes**. The user
  likes the example sub-classes (`knowledge-tool`, `local-llm`,
  `ai-editor`, `ai-search`) AND wants them to grow organically as new
  classes show up.

### My observation — we already have this mechanism

The dynamic-tag pattern is already in place: `use_cases` is a free
lowercase-tag vocabulary that the LLM research phase assigns per
record. The app's UI builds the use-case filter **dynamically from
whatever tags appear in the data** (already documented in SKILL.md).

So the sub-classes for `companion-app` records are just **more
`use_cases` tags**. The LLM is told to use the recommended vocabulary
(now including `knowledge-tool`, `local-llm`, `ai-editor`, `ai-search`,
`note-taking`, `voice`, etc.) and may mint new lowercase-hyphen tags
when nothing fits. No new schema field, no new filter widget.

Result: a record for Obsidian looks like:
- `category: companion-app`
- `use_cases: ["knowledge-tool", "note-taking", "rag", "free"]`
- `url: https://obsidian.md`
- `repo_url: null` (optional new field)
- `stars: null`, `version: null`, `contributors: null` (gracefully empty)

### Next: walk through the full research flow

User asked to verify the research flow with this in mind. We will:

1. Topic list change (research-topics.yaml additions).
2. Discover phase — what changes in the agent prompt so a non-GitHub
   tool is treated as legitimate?
3. Verify phase — today it WebFetches GitHub pages to verify stars;
   non-GitHub tools need a different verification (homepage exists,
   is genuinely free, is the kind of tool it claims).
4. Augment phase — branch on `repo_url`.
5. Build phase — schema change for `repo_url`, gracefully handle null
   metrics.
6. UI — `Stars` / `Version` / `Contributors` columns display "—" when
   null (already done) — sanity check this works.

### Q2 — Which `companion-app` topics for the first wave?

**Asked:** multi-select over 4 candidate topics.

**User selected + refined:**

1. **Free PKM / Markdown-notes apps with AI/RAG plugin ecosystem**
   (Obsidian, Logseq, Anytype, AppFlowy)
   — use_cases: `knowledge-tool`, `note-taking`, `rag`
2. **Free local-LLM-runner desktop apps, including mini-LLMs that can
   take over small tasks locally** (LM Studio, Jan.ai, Ollama desktop,
   GPT4All)
   — use_cases: `local-llm`, `token-efficiency`, `privacy`
3. **Free AI-aware code editors / standalone IDEs** (Cursor free tier,
   Zed AI, Windsurf, Continue.dev standalone)
   — use_cases: `ai-editor`, `development`
4. **Free AI dev-tools — VS Code / JetBrains / IDE AI plugins that
   support developers** (Continue.dev, Cline, Codeium, Aider, Tabnine
   free tier, ProxyAI, …)
   — use_cases: `ai-plugin`, `development`

User declined the AI-search-frontends topic (Perplexity/Phind/Kagi).

### Decision so far

- New category: `companion-app`
- 4 new topics in `research-topics.yaml`, each weight 4 (parity with the
  current weight-4 entries).
- `repo_url` optional schema field. `url` = canonical homepage. When
  `repo_url` is set, augment-phase fetches stars/version/contributors.
- UI: existing columns gracefully render "—" for null numeric fields,
  so no immediate UI change needed beyond renaming/regrouping.
- Sub-classification stays in `use_cases` (free-form tag space the LLM
  fills, UI builds filters dynamically — already implemented).

### Q3 — Verify phase: how to validate a non-GitHub entry?

**Asked:** homepage check vs companion-repo vs manual curate.

**User picked:** **Homepage WebFetch + plausibility check.**

So verify-phase changes:
- If `url` points at github.com → existing flow (WebFetch repo page, read
  star count, drop on 404).
- Else → WebFetch `url`, scan for:
  - tool/product page (not a 404, marketing-looking content present)
  - free tier explicit OR open-source notice (otherwise drop / lower
    confidence)
  - claims match what discover asserted (e.g. PKM tool actually claims
    note-taking; local-LLM tool actually claims local inference)
- Set `confidence: high|medium|low` based on signal strength.
- Drop entries where the homepage is clearly paid-only with no free tier.

Augment-phase: no-op for entries without `repo_url`. Records keep
null for stars/version/contributors and the UI already renders "—".

### Q4 — RAG when there is no README to chunk?

**Asked:** fields-chunk only / fetch+chunk homepage / fetch /docs.

**User picked:** **fields-chunk only.** YAGNI.

Backfill change: when a record has no `repo_url` (and the legacy
backfill code would derive a slug from `url` that isn't github.com),
skip the README-fetch path entirely. The fields-chunk alone goes in.
We already empirically showed (earlier in this session) that fields-only
retrieval is sharp on the existing corpus.

### Q5 — UI changes for mixed-corpus

**Asked:** minimal rename / + category badge / + homepage-icon.

**User picked:** **+ homepage-icon variant.**

Concrete UI changes:
- Column header `Repo` → `Name`.
- The cell now renders a small icon next to the linked name:
  - GitHub octocat / fork icon when `url` matches `github.com/...`
  - Globe icon otherwise (companion-apps with bare homepage URLs)
- Stars / Version / Contributors render "—" when null
  (already true today).
- Category filter list grows automatically since `categories` are
  enumerated from `report.json` server-side (verify this; if hard-coded,
  add `companion-app`).
- Use-cases filter is already dynamic from data, so new sub-class tags
  (`knowledge-tool`, `local-llm`, `ai-editor`, `ai-plugin`, …) appear
  as they show up.

DetailPanel: same change — icon next to the linked name in the header.

### Q6 — Optional `repo_url` field, or just URL pattern-check?

**Asked:** pattern-check on `url` / dedicated `repo_url` field.

**User picked:** **dedicated `repo_url` field.**

Rationale: a non-GitHub tool may also have a meaningful GitHub presence
(plugin-list repo, releases repo, awesome-list); we want to display
stars / version / contributors from that, while keeping `url` as the
canonical homepage link the user clicks.

Schema:
- `url` — canonical homepage. Always present.
- `repo_url` — optional. Points at a GitHub repo. When set, drives:
  - Augment phase: GitHub REST for stars/version/contributors.
  - Backfill (RAG): README fetch for chunks.
  - UI: the icon next to the name still derives from `url`; the
    repo_url shows as a small secondary link in DetailPanel
    (e.g. `↗ obsidianmd/obsidian-releases`).

For pure-GitHub records (existing 143), `repo_url` mirrors `url`. We
either backfill `repo_url = url` for existing records in the build
phase (default rule: when `repo_url` is absent AND `url` matches
github pattern → repo_url = url), or migrate raw-records once. The
build-time default is simpler — keeps `raw-records.json` lean.

### Q7 — First wave: infra only, or full research run?

**Asked:** scope of the first wave.

**User picked:** **infra first; seed with 1–2 hand-researched records
(Obsidian as the lead) so we have test data without running the full
pipeline.**

Seed entries (will go directly into `data/raw-records.json` as the
first companion-app records):

1. **Obsidian** — Markdown knowledge base, free for personal use, huge
   plugin ecosystem (Smart Connections / Copilot / Text Generator / etc.
   for AI/RAG). `repo_url` → `obsidianmd/obsidian-releases` (where the
   public release notes live; Obsidian core is closed-source so no
   contributor count there, but the releases repo gives version data).
2. **Logseq** — Open-source PKM, fully on GitHub, so a regular GitHub
   record. Acts as the contrast case: same category, but `repo_url`
   matches `url` and the GitHub augmenter fills everything.

Seed-record draft (will be inserted into raw-records.json):

```json
[
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
]
```

The Logseq seed will be researched live during implementation since it
follows the existing GitHub flow.







