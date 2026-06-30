# Companion-App Category Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth catalogue category `companion-app` (plus an optional `repo_url` schema field) so tools that don't live primarily on GitHub — Obsidian as the prototype — get a home alongside the 143 existing GitHub-based records, with the augment / RAG / UI pipelines gracefully degrading on non-GitHub entries.

**Architecture:** One new `category` enum value (`companion-app`), one new optional record field (`repo_url`), build-time fallback (`url` is github → `repo_url = url`). Augment + RAG-backfill prefer `repo_url` over `url`; both skip cleanly when neither yields a github slug. Pipeline prompts grow a non-GitHub branch. UI swaps the column header from `Repo` to `Name` and shows a Globe icon for non-github URLs vs an Octocat for github ones (inline SVG — no new dep). Two seed records (Obsidian + Logseq) prove the path end-to-end before any new workflow run.

**Tech Stack:** Node 20+, ESM, `better-sqlite3`, `node --test`, native `fetch`, React 18 + TanStack Table. No new dependencies.

## Global Constraints

- All new code lives where the existing module lives. No new top-level directories.
- ESM only (`.mjs` for server, `.ts/.tsx` for frontend).
- Backend tests run via `node --test`; frontend smoke tests via `vitest` are NOT required for this plan — UI changes are validated through the container smoke at the end.
- No new npm dependencies. Icons are inline SVG.
- `repo_url` is `string | null` everywhere it appears (raw-records.json optional, `report.json` always present).
- `category` enum grows from 3 to 4: `plugin-skill | mcp-server | token-tool | companion-app`.
- Spec reference: `docs/superpowers/specs/2026-06-30-non-github-tools-design.md`.

---

### Task 1: Add `companion-app` + `repo_url` to `build-report.mjs`

**Files:**
- Modify: `.claude/skills/efficiency-research/scripts/build-report.mjs`
- Modify: `.claude/skills/efficiency-research/scripts/build-report.test.mjs`

**Interfaces:**
- Consumes: nothing (entry point of the chain).
- Produces:
  - `CATEGORIES` includes `'companion-app'`.
  - `buildReport(raw, { generatedAt, date, query })` returns records with `repo_url: string | null` and the new category accepted.
  - Fallback rule: when `r.repo_url` is null/undefined AND `r.url` matches `https://github.com/{owner}/{repo}` → emitted record's `repo_url = r.url`. Otherwise `repo_url = r.repo_url ?? null`.

- [ ] **Step 1: Add three failing test cases**

Append to `.claude/skills/efficiency-research/scripts/build-report.test.mjs`:

```js
test("buildReport: accepts companion-app as a category", () => {
  const rep = buildReport(
    [
      {
        name: "Obsidian",
        url: "https://obsidian.md",
        repo_url: "https://github.com/obsidianmd/obsidian-releases",
        category: "companion-app",
        description: "PKM",
        efficiency_gain: "external memory",
        sources: [],
        confidence: "high",
        use_cases: ["knowledge-tool"],
      },
    ],
    { generatedAt: "t", date: "2026-06-30" },
  );
  assert.equal(rep.records.length, 1);
  assert.equal(rep.records[0].category, "companion-app");
  assert.equal(rep.records[0].repo_url, "https://github.com/obsidianmd/obsidian-releases");
});

test("buildReport: fallback — github url + no repo_url → repo_url = url", () => {
  const rep = buildReport(
    [
      {
        name: "acme/x",
        url: "https://github.com/acme/x",
        category: "plugin-skill",
        description: "d",
        efficiency_gain: "e",
        sources: [],
        confidence: "high",
        use_cases: ["dev"],
      },
    ],
    { generatedAt: "t", date: "2026-06-30" },
  );
  assert.equal(rep.records[0].repo_url, "https://github.com/acme/x");
});

test("buildReport: non-github url + no repo_url → repo_url stays null", () => {
  const rep = buildReport(
    [
      {
        name: "Obsidian",
        url: "https://obsidian.md",
        category: "companion-app",
        description: "PKM",
        efficiency_gain: "e",
        sources: [],
        confidence: "high",
        use_cases: ["knowledge-tool"],
      },
    ],
    { generatedAt: "t", date: "2026-06-30" },
  );
  assert.equal(rep.records[0].repo_url, null);
});
```

- [ ] **Step 2: Run the tests, watch them fail**

```bash
cd /home/jprentl/projects/claude-ai-tool-report
node --test .claude/skills/efficiency-research/scripts/build-report.test.mjs
```

Expected: 3 new tests fail. The category test fails with `bad category: companion-app`. The two `repo_url` tests fail because the field is not yet emitted.

- [ ] **Step 3: Patch `build-report.mjs`**

Edit `.claude/skills/efficiency-research/scripts/build-report.mjs`:

```js
// near the top
const CATEGORIES = ["plugin-skill", "mcp-server", "token-tool", "companion-app"];
const CATEGORY_TITLES = {
  "plugin-skill": "Plugins & Skills",
  "mcp-server": "MCP Servers",
  "token-tool": "Token & Research Tools",
  "companion-app": "Companion Apps",
};

const GITHUB_RE = /^https:\/\/github\.com\/[^/]+\/[^/?#]+/i;

function resolveRepoUrl(r) {
  if (typeof r.repo_url === "string" && r.repo_url.trim() !== "") return r.repo_url;
  if (typeof r.url === "string" && GITHUB_RE.test(r.url)) return r.url;
  return null;
}
```

In `buildReport`, inside the `records.push({ ... })` block, add `repo_url: resolveRepoUrl(r),` right after `url: r.url`. Full new push block:

```js
records.push({
  id,
  name: r.name,
  url: r.url,
  repo_url: resolveRepoUrl(r),
  category: r.category,
  stars: r.stars ?? null,
  stars_display: r.stars_display ?? null,
  version: r.version ?? null,
  contributors: r.contributors ?? null,
  description: r.description ?? "",
  efficiency_gain: r.efficiency_gain ?? "",
  sources: r.sources ?? [],
  confidence: r.confidence ?? "medium",
  use_cases: Array.isArray(r.use_cases) ? r.use_cases : [],
  last_researched: date,
});
```

- [ ] **Step 4: Run tests, expect green**

```bash
node --test .claude/skills/efficiency-research/scripts/build-report.test.mjs
```

Expected: all tests pass (existing + 3 new).

- [ ] **Step 5: Commit**

```bash
cd /home/jprentl/projects/claude-ai-tool-report
git add .claude/skills/efficiency-research/scripts/build-report.mjs .claude/skills/efficiency-research/scripts/build-report.test.mjs
git commit -m "feat(build): companion-app category + repo_url with github fallback"
```

---

### Task 2: `augment-github-meta.mjs` prefers `repo_url`, skips non-github cleanly

**Files:**
- Modify: `.claude/skills/efficiency-research/scripts/augment-github-meta.mjs`

**Interfaces:**
- Consumes: a record with optional `repo_url: string | null` and `url: string`.
- Produces: same record shape; for records whose `repo_url || url` is not a github URL, returns the record untouched (no network call, no error).

This task has no automated test — it's a behaviour change in a script that already runs against live GitHub. We verify by running it twice and checking stdout, then by reading back the resulting JSON in Task 11.

- [ ] **Step 1: Patch `slugOf` to prefer `repo_url`**

Edit `.claude/skills/efficiency-research/scripts/augment-github-meta.mjs`. Replace the existing `slugOf` with:

```js
function slugOf(rec) {
  // Prefer the explicit repo_url; fall back to the homepage URL only when
  // it points at a github repo. Non-github tools (e.g. obsidian.md) return
  // null and are skipped — they keep stars/version/contributors = null.
  const source = (rec.repo_url && rec.repo_url.trim()) || rec.url || "";
  const m = source.toLowerCase().match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (!m) return null;
  return `${m[1]}/${m[2].replace(/\.git$/, "")}`;
}
```

Then in `augmentOne(rec)`, the existing line `const slug = slugOf(rec);` already handles `null` by short-circuiting (`if (!slug) return rec;`). Verify that early return is in place — if not, add it.

- [ ] **Step 2: Smoke test — non-github record is a no-op**

```bash
cd /home/jprentl/projects/claude-ai-tool-report
cat > /tmp/aug-smoke.json <<'JSON'
[
  {"name":"Obsidian","url":"https://obsidian.md","category":"companion-app","stars":null,"description":"d","efficiency_gain":"e","sources":[],"confidence":"high","use_cases":["knowledge-tool"]}
]
JSON
set -a; . .env; set +a
node .claude/skills/efficiency-research/scripts/augment-github-meta.mjs /tmp/aug-smoke.json
```

Expected output mentions `0/1 have version` and `0/1 have contributor count`. No errors, no fetch attempts to obsidian.md. The file is rewritten with `version: null, contributors: null` for that record (or those fields absent and the record otherwise untouched).

- [ ] **Step 3: Smoke test — github record still works**

```bash
cat > /tmp/aug-smoke.json <<'JSON'
[
  {"name":"qdrant/mcp-server-qdrant","url":"https://github.com/qdrant/mcp-server-qdrant","category":"mcp-server","stars":null,"description":"d","efficiency_gain":"e","sources":[],"confidence":"high","use_cases":["rag"]}
]
JSON
node .claude/skills/efficiency-research/scripts/augment-github-meta.mjs /tmp/aug-smoke.json
cat /tmp/aug-smoke.json | python3 -c 'import json,sys; r=json.load(sys.stdin)[0]; print("version:", r.get("version"), "contributors:", r.get("contributors"))'
```

Expected: non-null `version` and `contributors` (Qdrant has both).

- [ ] **Step 4: Smoke test — repo_url overrides url**

```bash
cat > /tmp/aug-smoke.json <<'JSON'
[
  {"name":"Obsidian","url":"https://obsidian.md","repo_url":"https://github.com/obsidianmd/obsidian-releases","category":"companion-app","description":"d","efficiency_gain":"e","sources":[],"confidence":"high","use_cases":["knowledge-tool"]}
]
JSON
node .claude/skills/efficiency-research/scripts/augment-github-meta.mjs /tmp/aug-smoke.json
cat /tmp/aug-smoke.json | python3 -c 'import json,sys; r=json.load(sys.stdin)[0]; print("version:", r.get("version"), "contributors:", r.get("contributors"))'
```

Expected: `version` is the latest tag of the releases repo (e.g. `1.6.5`), `contributors` is small (1–5).

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/efficiency-research/scripts/augment-github-meta.mjs
git commit -m "feat(augment): prefer repo_url; skip non-github records cleanly"
```

---

### Task 3: Update `research-topics.yaml`

**Files:**
- Modify: `research-topics.yaml`

**Interfaces:**
- Consumes: nothing.
- Produces: yaml file with the four new `companion-app` topics added. Header comment lists four categories.

- [ ] **Step 1: Edit the header comment + append topics**

Open `research-topics.yaml`. Change line 5 from:

```yaml
# category must be one of: plugin-skill | mcp-server | token-tool
```

to:

```yaml
# category must be one of: plugin-skill | mcp-server | token-tool | companion-app
```

Append at the end of `topics:`:

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

- [ ] **Step 2: Verify the file parses (light YAML sanity)**

```bash
cd /home/jprentl/projects/claude-ai-tool-report
python3 -c 'import yaml; t = yaml.safe_load(open("research-topics.yaml")); print(f"topics={len(t[\"topics\"])}, last_cat={t[\"topics\"][-1][\"category\"]}")'
```

Expected: `topics=15, last_cat=companion-app`.

- [ ] **Step 3: Commit**

```bash
git add research-topics.yaml
git commit -m "feat(topics): four companion-app research topics"
```

---

### Task 4: Extend `research-pipeline.js` prompts + schema

**Files:**
- Modify: `.claude/skills/efficiency-research/pipeline/research-pipeline.js`
- Modify: `.claude/skills/efficiency-research/pipeline/rag-pipeline.js` (parallel change, same schema)

**Interfaces:**
- Consumes: research-topics.yaml (Task 3).
- Produces: workflow scripts whose record schema includes `repo_url: string | null`, and whose Discover + Verify prompts treat non-GitHub homepages as legitimate.

This task has no automated test — workflow scripts are exercised by running the actual workflow against the LLM, which is Phase 2 (out of scope). We verify only that the file parses as JavaScript.

- [ ] **Step 1: Grow `RECORD_SCHEMA` in `research-pipeline.js`**

In `.claude/skills/efficiency-research/pipeline/research-pipeline.js`, locate `RECORD_SCHEMA`. Inside `items.properties`, after the `url` entry add:

```js
          repo_url: { type: ['string', 'null'], description: 'GitHub repo url when distinct from the homepage; null for pure homepage records' },
```

Update `CATS`:

```js
const CATS = 'plugin-skill | mcp-server | token-tool | companion-app'
```

- [ ] **Step 2: Extend the Discover prompt**

In the same file, locate the Discover agent prompt. After the `Only include REAL, existing repos.` line, append:

```text
\n\nFor companion-app entries (free tools that aren't primarily a GitHub repo — Obsidian, LM Studio, Cursor, etc.): set url to the canonical homepage. Optionally fill repo_url if a meaningful GitHub presence exists (releases repo, plugin-list repo). For pure-GitHub records, leave repo_url null — the build step will fall back to url. Only include tools whose homepage explicitly offers a free tier or open-source licence.
```

- [ ] **Step 3: Extend the Verify prompt**

In the same file, locate the Verify agent prompt. After the `KEEP every other field UNCHANGED` line, append:

```text
\nFor non-github.com urls: WebFetch the homepage and confirm (1) product page is live, (2) free tier or open-source claim is explicit on the page, (3) claimed capability matches the description. Drop entries that are paywalled with no free tier. Preserve repo_url unchanged when present.
```

- [ ] **Step 4: Mirror the schema change in `rag-pipeline.js`**

Open `.claude/skills/efficiency-research/pipeline/rag-pipeline.js`. Find its `RECORD_SCHEMA`, apply the same `repo_url` insertion + `CATS` extension. (No prompt change needed there since rag-pipeline targets RAG-specific topics that are predominantly GitHub.)

- [ ] **Step 5: JS-parse sanity check**

```bash
cd /home/jprentl/projects/claude-ai-tool-report
node --check .claude/skills/efficiency-research/pipeline/research-pipeline.js
node --check .claude/skills/efficiency-research/pipeline/rag-pipeline.js
```

Expected: both commands exit 0 with no output.

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/efficiency-research/pipeline/research-pipeline.js .claude/skills/efficiency-research/pipeline/rag-pipeline.js
git commit -m "feat(pipeline): companion-app prompts + repo_url in record schema"
```

---

### Task 5: Backfill prefers `repo_url`

**Files:**
- Modify: `app/server/embeddings/backfill.mjs`
- Modify: `app/server/embeddings/backfill.test.mjs`

**Interfaces:**
- Consumes: record with optional `repo_url`.
- Produces: same backfill function, but `repoSlugFromRecord` now derives the slug from `rec.repo_url || rec.url`. A record whose neither field is a github URL contributes only the fields-chunk.

- [ ] **Step 1: Add a failing test**

Append to `app/server/embeddings/backfill.test.mjs`:

```js
test("backfill: non-github record (no repo_url) embeds only the fields chunk", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    let fetchCalls = 0;
    const result = await runBackfill({
      records: [
        {
          ...RECORD,
          id: "obsidian",
          name: "Obsidian",
          url: "https://obsidian.md",
          repo_url: null,
        },
      ],
      client: makeClient(),
      store,
      config: { ...CFG, githubToken: "ghp" },
      fetchReadmeFn: async () => {
        fetchCalls++;
        return "# Should not be called";
      },
      log: QUIET_LOG,
    });
    assert.equal(result.embedded, 1, "only the fields chunk");
    assert.equal(fetchCalls, 0, "no README fetch when neither repo_url nor github url is present");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("backfill: record with repo_url uses it for the README fetch", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    let lastSlug = null;
    const result = await runBackfill({
      records: [
        {
          ...RECORD,
          id: "obsidian",
          name: "Obsidian",
          url: "https://obsidian.md",
          repo_url: "https://github.com/obsidianmd/obsidian-releases",
        },
      ],
      client: makeClient(),
      store,
      config: { ...CFG, githubToken: "ghp" },
      fetchReadmeFn: async ({ repoSlug }) => {
        lastSlug = repoSlug;
        return "# Title\n\nbody";
      },
      log: QUIET_LOG,
    });
    assert.equal(lastSlug, "obsidianmd/obsidian-releases");
    assert.ok(result.embedded >= 2, "fields + readme chunks");
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run, watch failure**

```bash
cd /home/jprentl/projects/claude-ai-tool-report/app
node --test server/embeddings/backfill.test.mjs
```

Expected: the two new tests fail (the second because `repoSlugFromRecord` currently reads only `url`, so it returns null for an obsidian.md primary URL; the first should already pass since the existing code drops to fields-chunk anyway).

- [ ] **Step 3: Patch `backfill.mjs`**

Open `app/server/embeddings/backfill.mjs`. Replace the existing `repoSlugFromRecord` with:

```js
function repoSlugFromRecord(rec) {
  // Prefer the explicit repo_url; fall back to url only when it
  // points at github. Pure-homepage records (Obsidian etc.) get null.
  const source = (rec.repo_url && String(rec.repo_url).trim()) || rec.url || rec.name || "";
  const m = String(source)
    .toLowerCase()
    .match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (m) return `${m[1]}/${m[2].replace(/\.git$/, "")}`;
  return null;
}
```

- [ ] **Step 4: Run, expect green**

```bash
node --test server/embeddings/backfill.test.mjs
```

Expected: all backfill tests pass.

- [ ] **Step 5: Commit**

```bash
cd /home/jprentl/projects/claude-ai-tool-report
git add app/server/embeddings/backfill.mjs app/server/embeddings/backfill.test.mjs
git commit -m "feat(rag): backfill prefers repo_url for slug derivation"
```

---

### Task 6: Frontend `types.ts` updates

**Files:**
- Modify: `app/web/types.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `Rec` interface with `repo_url: string | null` and the grown `category` union. All downstream React components compile against the new shape.

- [ ] **Step 1: Edit `types.ts`**

Rewrite to:

```ts
export interface Rec {
  id: string;
  name: string;
  url: string;
  repo_url: string | null;
  category: "plugin-skill" | "mcp-server" | "token-tool" | "companion-app";
  stars: number | null;
  stars_display: string | null;
  version: string | null;
  contributors: number | null;
  description: string;
  efficiency_gain: string;
  sources: string[];
  confidence: string;
  use_cases: string[];
  last_researched: string;
  flagged: boolean;
  note: string;
}
export type ChatScope = "record" | "selection" | "global";
```

- [ ] **Step 2: Typecheck sanity**

```bash
cd /home/jprentl/projects/claude-ai-tool-report/app
npx tsc --noEmit -p tsconfig.json 2>&1 | head -40
```

Expected output: no errors related to `Rec`. (Other unrelated warnings, if any, are fine — we only care about the new field type-checking through.)

- [ ] **Step 3: Commit**

```bash
cd /home/jprentl/projects/claude-ai-tool-report
git add app/web/types.ts
git commit -m "feat(web): Rec type grows repo_url + companion-app category"
```

---

### Task 7: Inline-SVG icons + Name column with icon

**Files:**
- Create: `app/web/icons.tsx`
- Modify: `app/web/columns.tsx`

**Interfaces:**
- Consumes: `Rec` (Task 6).
- Produces:
  - `GithubIcon({ size?: number })` — small octocat SVG.
  - `GlobeIcon({ size?: number })` — small globe SVG.
  - `isGithubUrl(url: string): boolean` predicate.
  - The Name column in `columns.tsx` (replacing the old Repo column) renders one of the two icons next to the link.

- [ ] **Step 1: Create the icons module**

Create `app/web/icons.tsx`:

```tsx
import type { ReactElement } from "react";

// True when the url looks like https://github.com/{owner}/{repo}.
// We accept extra path / query / fragment, but require at least the
// owner+repo segments.
export function isGithubUrl(url: string | null | undefined): boolean {
  if (!url) return false;
  return /^https:\/\/github\.com\/[^/]+\/[^/?#]+/i.test(url);
}

const baseProps = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.6,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

export function GithubIcon({ size = 14 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...baseProps} aria-hidden>
      <path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 0 0-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0 0 20 4.77 5.07 5.07 0 0 0 19.91 1S18.73.65 16 2.48a13.38 13.38 0 0 0-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 0 0 5 4.77a5.44 5.44 0 0 0-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 0 0 9 18.13V22" />
    </svg>
  );
}

export function GlobeIcon({ size = 14 }: { size?: number }): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" {...baseProps} aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <line x1="2" y1="12" x2="22" y2="12" />
      <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
    </svg>
  );
}
```

- [ ] **Step 2: Update `columns.tsx` — header rename + icon cell**

Open `app/web/columns.tsx`. At the top, add the new import:

```tsx
import { GithubIcon, GlobeIcon, isGithubUrl } from "./icons";
```

Replace the existing `name` column block:

```tsx
  {
    accessorKey: "name",
    header: "Repo",
    cell: (info) => (
      <a
        className="font-mono text-accent underline-offset-2 hover:underline"
        href={info.row.original.url}
        target="_blank"
        rel="noreferrer"
      >
        {info.getValue() as string}
      </a>
    ),
  },
```

with:

```tsx
  {
    accessorKey: "name",
    header: "Name",
    cell: (info) => {
      const r = info.row.original;
      const Icon = isGithubUrl(r.url) ? GithubIcon : GlobeIcon;
      return (
        <a
          className="inline-flex items-center gap-1.5 font-mono text-accent underline-offset-2 hover:underline"
          href={r.url}
          target="_blank"
          rel="noreferrer"
          title={isGithubUrl(r.url) ? "GitHub repo" : "Homepage"}
        >
          <Icon />
          {info.getValue() as string}
        </a>
      );
    },
  },
```

- [ ] **Step 3: Frontend build sanity**

```bash
cd /home/jprentl/projects/claude-ai-tool-report/app
npx tsc --noEmit -p tsconfig.json 2>&1 | head -20
```

Expected: no errors in `columns.tsx` or `icons.tsx`. Pre-existing warnings (if any) are fine.

- [ ] **Step 4: Commit**

```bash
cd /home/jprentl/projects/claude-ai-tool-report
git add app/web/icons.tsx app/web/columns.tsx
git commit -m "feat(web): Name column with Github/Globe icon"
```

---

### Task 8: DetailPanel icon + optional repo line

**Files:**
- Modify: `app/web/DetailPanel.tsx`

**Interfaces:**
- Consumes: `GithubIcon`, `GlobeIcon`, `isGithubUrl` (Task 7).
- Produces: side-panel header that shows the same icon next to the linked name and, when `repo_url` is set and differs from `url`, an extra `Repo: owner/name` line linking to the github repo.

- [ ] **Step 1: Patch DetailPanel**

Open `app/web/DetailPanel.tsx`. At the top imports, add:

```tsx
import { GithubIcon, GlobeIcon, isGithubUrl } from "./icons";
```

Replace the existing header `<a>` block (lines around the `record.name` link) with:

```tsx
        <a
          className="inline-flex items-center gap-1.5 font-mono text-base font-medium text-accent underline-offset-2 hover:underline truncate"
          href={record.url}
          target="_blank"
          rel="noreferrer"
          title={isGithubUrl(record.url) ? "GitHub repo" : "Homepage"}
        >
          {isGithubUrl(record.url) ? <GithubIcon size={16} /> : <GlobeIcon size={16} />}
          {record.name}
        </a>
```

Below the category/stars/version/contributors meta line, BEFORE the description `<p>`, add the optional repo line:

```tsx
      {record.repo_url && record.repo_url !== record.url && (
        <a
          href={record.repo_url}
          target="_blank"
          rel="noreferrer"
          className="mt-1 inline-flex items-center gap-1.5 font-mono text-[11px] text-muted hover:text-accent underline-offset-2 hover:underline"
        >
          <GithubIcon size={12} />
          ↗ Repo: {record.repo_url.replace(/^https:\/\/github\.com\//, "")}
        </a>
      )}
```

- [ ] **Step 2: Typecheck**

```bash
cd /home/jprentl/projects/claude-ai-tool-report/app
npx tsc --noEmit -p tsconfig.json 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
cd /home/jprentl/projects/claude-ai-tool-report
git add app/web/DetailPanel.tsx
git commit -m "feat(web): DetailPanel icon + secondary repo link"
```

---

### Task 9: Seed records + augment + rebuild

**Files:**
- Modify: `data/raw-records.json` (append two records)

**Interfaces:**
- Consumes: build-report fallback (Task 1), augment slug rule (Task 2), backfill rule (Task 5), web changes (Tasks 6–8).
- Produces: a `data/report.json` that contains the new `companion-app` category populated with Obsidian + Logseq, augmented with GitHub-derived stars/version/contributors where possible.

`data/raw-records.json` is gitignored, so this task has no commit. The verification is the container smoke in Task 10.

- [ ] **Step 1: Inspect `data/raw-records.json` to find the insertion point**

```bash
cd /home/jprentl/projects/claude-ai-tool-report
python3 -c 'import json; d=json.load(open("data/raw-records.json")); print(f"current count: {len(d)}")'
```

Expected: 143 records.

- [ ] **Step 2: Append the two seed records via a one-shot Python edit**

```bash
cd /home/jprentl/projects/claude-ai-tool-report
python3 - <<'PY'
import json, pathlib
p = pathlib.Path("data/raw-records.json")
records = json.loads(p.read_text())
seed = [
  {
    "name": "Obsidian",
    "url": "https://obsidian.md",
    "repo_url": "https://github.com/obsidianmd/obsidian-releases",
    "category": "companion-app",
    "stars": None,
    "stars_display": None,
    "description": "Local-first Markdown knowledge base with a thriving plugin ecosystem that includes AI/RAG plugins (Smart Connections, Copilot, Text Generator) and Anthropic-API-compatible chat plugins.",
    "efficiency_gain": "Acts as Claude's external memory: an indexed personal knowledge base the user can curate manually and feed into RAG with a plugin.",
    "sources": ["https://obsidian.md", "https://github.com/obsidianmd/obsidian-releases"],
    "confidence": "high",
    "use_cases": ["knowledge-tool", "note-taking", "rag", "free"]
  },
  {
    "name": "logseq/logseq",
    "url": "https://github.com/logseq/logseq",
    "repo_url": "https://github.com/logseq/logseq",
    "category": "companion-app",
    "stars": None,
    "stars_display": None,
    "description": "Open-source local-first outliner and PKM tool with a graph view. Plugin ecosystem includes Smart Connections-style AI helpers.",
    "efficiency_gain": "Offline-friendly Markdown knowledge base; same RAG-feeding role as Obsidian but fully open-source.",
    "sources": ["https://github.com/logseq/logseq"],
    "confidence": "high",
    "use_cases": ["knowledge-tool", "note-taking", "rag", "free"]
  },
]
# Skip if either id is already present (idempotency on repeated runs).
existing_names = {r["name"] for r in records}
added = []
for s in seed:
  if s["name"] not in existing_names:
    records.append(s)
    added.append(s["name"])
p.write_text(json.dumps(records, indent=2) + "\n")
print(f"added: {added}")
print(f"new count: {len(records)}")
PY
```

Expected: `added: ['Obsidian', 'logseq/logseq']`, `new count: 145`.

- [ ] **Step 3: Run augment to fill in GitHub-derived fields**

```bash
cd /home/jprentl/projects/claude-ai-tool-report
set -a; . .env; set +a
npm run report:augment 2>&1 | tail -8
```

Expected: log says `1xx/145 have version`, `145/145 have contributor count` (Logseq fills both; Obsidian likely fills version from the releases repo, contributors small).

- [ ] **Step 4: Build the report**

```bash
npm run report:build
```

Expected: `Wrote 145 records -> data/report.json, data/report.md`.

- [ ] **Step 5: Verify the new records are present and shaped correctly**

```bash
python3 - <<'PY'
import json
d = json.load(open("data/report.json"))
print(f"total: {len(d['records'])}")
companions = [r for r in d['records'] if r['category'] == 'companion-app']
print(f"companion-app: {len(companions)}")
for r in companions:
  print(f"  {r['name']:25s} url={r['url']:45s} repo_url={r['repo_url']}")
  print(f"    stars={r['stars_display']!s:8s} version={r['version']!s:25s} contributors={r['contributors']}")
PY
```

Expected: 2 companion-app records, Obsidian's `url` is `https://obsidian.md`, Logseq's `url` is the github URL, both have non-null `repo_url`.

- [ ] **Step 6: Verify the existing 143 records got the github fallback**

```bash
python3 - <<'PY'
import json
d = json.load(open("data/report.json"))
missing = [r for r in d['records'] if r['repo_url'] is None and r['category'] != 'companion-app']
print(f"non-companion-app records with null repo_url: {len(missing)}")
PY
```

Expected: `0`.

No commit — `data/raw-records.json`, `data/report.json`, `data/report.md` are gitignored.

---

### Task 10: Container smoke

**Files:** none modified — verification only.

**Interfaces:** consumes everything above.

- [ ] **Step 1: Rebuild + restart**

```bash
cd /home/jprentl/projects/claude-ai-tool-report
./run.sh stop
./run.sh --build
```

Expected: build succeeds (no new deps). Container starts. First boot embeds the 2 new fields-chunks (the 143 existing skip-via-text-hash), boot log shows `embedded=2 skipped=143 failed=0` or similar.

- [ ] **Step 2: Wait for ready**

```bash
for i in $(seq 1 20); do
  sleep 5
  if curl -sf http://localhost:8788/api/health >/dev/null 2>&1; then echo "ready"; break; fi
done
```

- [ ] **Step 3: Verify the API surfaces the new shape**

```bash
curl -sS http://localhost:8788/api/records > /tmp/recs.json
python3 - <<'PY'
import json
d = json.load(open("/tmp/recs.json"))
companions = [r for r in d['records'] if r['category'] == 'companion-app']
print(f"companion-app: {len(companions)}")
assert all('repo_url' in r for r in d['records']), "missing repo_url somewhere"
for r in companions:
  print(f"  {r['name']:25s} version={r['version']!s:20s} contributors={r['contributors']}")
print("OK")
PY
```

Expected: prints `companion-app: 2`, lines for Obsidian and Logseq, ends with `OK`.

- [ ] **Step 4: Manual UI smoke (browser)**

Open `http://localhost:8788`. Expected:
- Tabelle hat eine Name-Spalte (nicht mehr "Repo"). Vor jedem Namen ein kleines Icon. Obsidian zeigt einen Globe, Logseq einen Github-Octocat.
- Klick auf Obsidian → side-panel öffnet sich. Header zeigt Globe + Obsidian. Eine kleine Zeile unten zeigt `↗ Repo: obsidianmd/obsidian-releases` als sekundärer Link.
- Klick auf einen alten Eintrag (z.B. `qdrant/mcp-server-qdrant`) → Github-Octocat + Repo-Link wird NICHT gezeigt (weil `url == repo_url`).

- [ ] **Step 5: Verify chat still works with the new records**

```bash
curl -sS -X POST http://localhost:8788/api/chat -H 'content-type: application/json' \
  -d '{"scope":"record","ids":["obsidian"],"message":"In one short sentence: what is this and why does it help with Claude?"}' \
  --max-time 30 | python3 -c 'import json,sys; r=json.load(sys.stdin); print(r.get("answer",r))'
```

Expected: a sensible 1-line answer about Obsidian. No 500.

```bash
curl -sS -X POST http://localhost:8788/api/chat -H 'content-type: application/json' \
  -d '{"scope":"global","message":"recommend one local knowledge tool"}' \
  --max-time 30 > /tmp/g.json
python3 -c 'import json; d=json.load(open("/tmp/g.json")); print("mode:", d["retrieval"]["mode"]); [print(" ", h["score"], h["recordId"]) for h in d["retrieval"]["hits"]]'
```

Expected: `mode: rag`, hits include `obsidian` and `logseq-logseq` near the top.

- [ ] **Step 6: No commit needed — operational verification only**

---

### Task 11: Push

**Files:** none.

- [ ] **Step 1: Confirm clean working tree, secret scan**

```bash
cd /home/jprentl/projects/claude-ai-tool-report
git status --short
git diff origin/main..HEAD 2>&1 | grep -iE "sk-ant-|ghp_[A-Za-z0-9]{20}|68996b4e|trustbundle\.bmw" | head
```

Expected: working tree clean (data/ files are gitignored), grep returns nothing.

- [ ] **Step 2: Push**

```bash
git push origin main
```

Expected: `origin/main` advances to the new HEAD.

---

## Self-Review

**Spec coverage:**
- Schema (categories + repo_url) → Task 1
- Build-report fallback → Task 1
- Augment script → Task 2
- research-topics.yaml → Task 3
- research-pipeline.js + rag-pipeline.js prompts + schema → Task 4
- backfill.mjs slug rule → Task 5
- types.ts → Task 6
- columns.tsx Name + icon → Task 7
- DetailPanel icon + repo line → Task 8
- Seed data + augment + report:build → Task 9
- Container smoke + chat verification → Task 10
- Push → Task 11

All spec sections covered. Phase 2 (workflow run) is explicitly out of scope per the spec.

**Placeholder scan:** every step has either a code block or an exact command + expected output. No "TBD" or "handle edge cases" left in the plan.

**Type consistency:**
- `repo_url: string | null` appears identically in build-report (Task 1), augment (Task 2 implicitly via slugOf), pipeline schema (Task 4), backfill (Task 5), types.ts (Task 6).
- `companion-app` enum member appears in build-report.mjs CATEGORIES, types.ts union, pipeline `CATS` string, research-topics.yaml header. All four spellings identical.
- `isGithubUrl` predicate defined once in `icons.tsx` (Task 7), reused in `columns.tsx` (Task 7) and `DetailPanel.tsx` (Task 8).
- `GithubIcon` / `GlobeIcon` names match across icons.tsx and both consumers.

No gaps, no inconsistencies.
