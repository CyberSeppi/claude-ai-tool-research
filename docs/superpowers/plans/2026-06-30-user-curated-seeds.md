# User-Curated Seeds Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the throw-away CLI overlay (`data/seeds.json` + `merge-seeds.mjs`) with a first-class "Add Tool" feature: a toolbar button opens a modal where the user pastes a URL, the backend auto-fills every field via GitHub REST or LLM extraction, the user reviews, hits Save, and the record appears in the table tagged ⭐ curated. Seeds live in `app/db/seeds.json` (db-volume), merge with the workflow's `raw-records.json` in-memory per `GET /api/records`, are indexed into the RAG store asynchronously, and survive every workflow re-run.

**Architecture:** New backend modules `seeds.mjs` (storage) and `enrich.mjs` (auto-fill), four new Hono endpoints, a `loadReport(dataDir, dbDir)` upgrade that merges seeds in-memory, an `indexRecord()` helper that wraps the existing backfill loop body, plus a new React `AddToolModal.tsx`, two extended files (`columns.tsx`, `DetailPanel.tsx`), and a tiny `api.ts` extension. The CLI seed mechanism from commit `9a71780` is fully removed in its own task.

**Tech Stack:** Node 20 + ESM, Hono, `better-sqlite3`, `node --test`, React 18, TanStack Table, Vite/Vitest. No new npm dependencies (icons stay inline-SVG; LLM extraction uses the existing `llm` client).

## Global Constraints

- All new server code lives under `app/server/`. All frontend code under `app/web/`.
- ESM only. `.mjs` for server, `.ts`/`.tsx` for frontend.
- Backend tests use `node --test`. Frontend tests use `vitest`.
- No new dependencies. Reuse existing `undici` proxy plumbing for outbound fetch.
- Atomic disk writes for `app/db/seeds.json` (tmp + rename), same pattern as `app/server/flags.mjs`.
- Slug formula MUST match `augment-github-meta.mjs` and `embeddings/backfill.mjs`:
  `source = repo_url || url || name; lower-match github.com/{owner}/{repo}; else lower(name).trim()`.
- Categories enum (4 values): `plugin-skill | mcp-server | token-tool | companion-app`.
- POST validation: `name` non-empty, `url` parseable http(s), `category` in enum.
- Slug uniqueness checked against BOTH seeds.json AND the current raw-records.json. Collision returns `409 { existing: 'raw' | 'seed' }`.
- Spec reference: `docs/superpowers/specs/2026-06-30-user-curated-seeds-design.md`.

---

### Task 1: Remove the CLI seed mechanism (clean migration)

**Files:**
- Delete: `data/seeds.json`
- Delete: `.claude/skills/efficiency-research/scripts/merge-seeds.mjs`
- Modify: `package.json` (remove `report:seed` script)
- Modify: `.gitignore` (drop the seeds.json protective comment block)

**Interfaces:** none produced; this is the clean-slate task that earlier features built on.

- [ ] **Step 1: Remove the old files**

```bash
cd /home/jprentl/projects/claude-ai-tool-report
git rm data/seeds.json
git rm .claude/skills/efficiency-research/scripts/merge-seeds.mjs
```

- [ ] **Step 2: Remove the `report:seed` script from `package.json`**

Open `package.json`. Change:

```json
  "scripts": {
    "test:skill": "node --test .claude/skills/efficiency-research/scripts/*.test.mjs",
    "report:build": "node .claude/skills/efficiency-research/scripts/build-report.mjs",
    "report:augment": "node .claude/skills/efficiency-research/scripts/augment-github-meta.mjs",
    "report:recover": "node .claude/skills/efficiency-research/scripts/recover-from-journal.mjs",
    "report:seed": "node .claude/skills/efficiency-research/scripts/merge-seeds.mjs"
  }
```

to:

```json
  "scripts": {
    "test:skill": "node --test .claude/skills/efficiency-research/scripts/*.test.mjs",
    "report:build": "node .claude/skills/efficiency-research/scripts/build-report.mjs",
    "report:augment": "node .claude/skills/efficiency-research/scripts/augment-github-meta.mjs",
    "report:recover": "node .claude/skills/efficiency-research/scripts/recover-from-journal.mjs"
  }
```

- [ ] **Step 3: Clean up `.gitignore`**

Open `.gitignore`. Find the block:

```
data/raw-records.json
data/report.json
data/report.md
# data/seeds.json is intentionally NOT listed here — it is the committed
# source of truth for manually curated records that survive every
# research-pipeline.js re-run. Do NOT add data/ as a catch-all.
```

Replace with (drop the seeds.json comment block — feature is gone):

```
data/raw-records.json
data/report.json
data/report.md
```

- [ ] **Step 4: Verify nothing else references the removed pieces**

```bash
cd /home/jprentl/projects/claude-ai-tool-report
grep -rn "merge-seeds\|report:seed\|data/seeds.json" \
  --include='*.mjs' --include='*.ts' --include='*.tsx' --include='*.js' \
  --include='*.json' --include='*.md' \
  --exclude-dir=node_modules --exclude-dir=.git \
  2>/dev/null | grep -v 'docs/superpowers/specs/2026-06-30-user-curated-seeds-design.md' \
                | grep -v 'docs/superpowers/plans/2026-06-30-user-curated-seeds.md' \
                | grep -v 'data/raw-records.json.bak'
```

Expected: no output. (The spec and plan reference the names by intent, but the grep above excludes them. `.bak` filenames are fine.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove CLI seed mechanism — replaced by in-app feature

The data/seeds.json + merge-seeds.mjs + report:seed pipeline step
introduced in 9a71780 was a CLI-only workaround. It's replaced this
session by an in-app 'Add Tool' feature with its own runtime storage,
backend endpoints, and modal UI. See:
- docs/superpowers/specs/2026-06-30-user-curated-seeds-design.md
- docs/superpowers/plans/2026-06-30-user-curated-seeds.md

claude-mem (the previous seed) is currently surfaced by the workflow's
discover phase (85k stars), so it stays in the catalogue without any
seed override."
```

---

### Task 2: `app/server/seeds.mjs` — storage layer

**Files:**
- Create: `app/server/seeds.mjs`
- Create: `app/server/seeds.test.mjs`

**Interfaces:**
- Consumes: nothing (entry point of the new chain).
- Produces:
  - `slugOf(record) → string | null` — must match `augment-github-meta.mjs`.
  - `readSeeds(dbDir) → Seed[]` — empty array when file missing.
  - `writeSeedsAtomic(dbDir, seeds) → void` — tmp + rename.
  - `addSeed(dbDir, seed, now?) → { seed }` — throws `Error('SLUG_EXISTS_SEED')` on collision with existing seed.
  - `updateSeed(dbDir, slug, patch, now?) → { seed }` — throws `Error('NO_SUCH_SEED')` when slug missing.
  - `deleteSeed(dbDir, slug) → boolean` — true if removed, false if not present.

- [ ] **Step 1: Write the failing test**

Create `app/server/seeds.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  slugOf,
  readSeeds,
  writeSeedsAtomic,
  addSeed,
  updateSeed,
  deleteSeed,
} from "./seeds.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "seeds-"));
}

test("slugOf: github url → owner/repo lowercase, .git stripped", () => {
  assert.equal(
    slugOf({ url: "https://github.com/Foo/Bar.git" }),
    "foo/bar",
  );
});

test("slugOf: repo_url wins over url", () => {
  assert.equal(
    slugOf({
      url: "https://obsidian.md",
      repo_url: "https://github.com/obsidianmd/obsidian-releases",
    }),
    "obsidianmd/obsidian-releases",
  );
});

test("slugOf: non-github → lower(name)", () => {
  assert.equal(slugOf({ url: "https://obsidian.md", name: "Obsidian" }), "obsidian");
});

test("readSeeds: missing file → empty array", () => {
  const dir = tmp();
  try {
    assert.deepEqual(readSeeds(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeSeedsAtomic: writes to .tmp then renames; no .tmp leftover", () => {
  const dir = tmp();
  try {
    writeSeedsAtomic(dir, [{ name: "X", url: "https://x", category: "plugin-skill" }]);
    assert.equal(existsSync(join(dir, "seeds.json")), true);
    assert.equal(existsSync(join(dir, "seeds.json.tmp")), false);
    const parsed = JSON.parse(readFileSync(join(dir, "seeds.json"), "utf8"));
    assert.equal(parsed.records.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addSeed: appends + stamps added_at/updated_at", () => {
  const dir = tmp();
  try {
    const now = new Date("2026-06-30T10:00:00Z");
    const { seed } = addSeed(
      dir,
      { name: "X", url: "https://x", category: "plugin-skill" },
      now,
    );
    assert.equal(seed.name, "X");
    assert.equal(seed.added_at, now.toISOString());
    assert.equal(seed.updated_at, now.toISOString());
    assert.equal(readSeeds(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addSeed: slug collision throws SLUG_EXISTS_SEED", () => {
  const dir = tmp();
  try {
    addSeed(dir, { name: "A", url: "https://github.com/x/y", category: "plugin-skill" });
    assert.throws(
      () =>
        addSeed(dir, {
          name: "A2",
          url: "https://github.com/x/y",
          category: "plugin-skill",
        }),
      /SLUG_EXISTS_SEED/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateSeed: patches fields + bumps updated_at; rejects unknown slug", () => {
  const dir = tmp();
  try {
    const t1 = new Date("2026-06-30T10:00:00Z");
    addSeed(
      dir,
      { name: "X", url: "https://x", category: "plugin-skill" },
      t1,
    );
    const t2 = new Date("2026-06-30T11:00:00Z");
    const { seed } = updateSeed(dir, "x", { description: "new" }, t2);
    assert.equal(seed.description, "new");
    assert.equal(seed.added_at, t1.toISOString());
    assert.equal(seed.updated_at, t2.toISOString());
    assert.throws(() => updateSeed(dir, "nope", {}), /NO_SUCH_SEED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteSeed: removes when present; false when absent", () => {
  const dir = tmp();
  try {
    addSeed(dir, { name: "X", url: "https://x", category: "plugin-skill" });
    assert.equal(deleteSeed(dir, "x"), true);
    assert.equal(deleteSeed(dir, "x"), false);
    assert.deepEqual(readSeeds(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests, watch them fail**

```bash
cd /home/jprentl/projects/claude-ai-tool-report/app
node --test server/seeds.test.mjs
```

Expected: FAIL — `Cannot find module './seeds.mjs'`.

- [ ] **Step 3: Implement `seeds.mjs`**

Create `app/server/seeds.mjs`:

```js
// Seed storage for user-curated records. Same atomic-write pattern as
// flags.mjs: write to .tmp, then rename. File lives in the db-volume
// at <dbDir>/seeds.json so the container can write it without touching
// the gitignored data/ tree.
//
// slugOf MUST match augment-github-meta.mjs and embeddings/backfill.mjs.
// Drift between the three is a phantom-duplicate bug.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const FILENAME = "seeds.json";

function path(dbDir) {
  return join(dbDir, FILENAME);
}

export function slugOf(record) {
  const source =
    (record.repo_url && String(record.repo_url).trim()) || record.url || record.name || "";
  const m = String(source)
    .toLowerCase()
    .match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (m) return `${m[1]}/${m[2].replace(/\.git$/, "")}`;
  return String(record.name ?? "").toLowerCase().trim() || null;
}

export function readSeeds(dbDir) {
  const p = path(dbDir);
  if (!existsSync(p)) return [];
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(parsed?.records) ? parsed.records : [];
  } catch {
    return [];
  }
}

export function writeSeedsAtomic(dbDir, records) {
  mkdirSync(dbDir, { recursive: true });
  const p = path(dbDir);
  const tmp = p + ".tmp";
  writeFileSync(tmp, JSON.stringify({ records }, null, 2) + "\n");
  renameSync(tmp, p);
}

export function addSeed(dbDir, partial, now = new Date()) {
  const records = readSeeds(dbDir);
  const slug = slugOf(partial);
  if (records.some((r) => slugOf(r) === slug)) {
    throw new Error("SLUG_EXISTS_SEED");
  }
  const iso = now.toISOString();
  const seed = { ...partial, added_at: iso, updated_at: iso };
  records.push(seed);
  writeSeedsAtomic(dbDir, records);
  return { seed };
}

export function updateSeed(dbDir, slug, patch, now = new Date()) {
  const records = readSeeds(dbDir);
  const idx = records.findIndex((r) => slugOf(r) === slug);
  if (idx === -1) throw new Error("NO_SUCH_SEED");
  const merged = { ...records[idx], ...patch, updated_at: now.toISOString() };
  // added_at is immutable
  merged.added_at = records[idx].added_at;
  records[idx] = merged;
  writeSeedsAtomic(dbDir, records);
  return { seed: merged };
}

export function deleteSeed(dbDir, slug) {
  const records = readSeeds(dbDir);
  const next = records.filter((r) => slugOf(r) !== slug);
  if (next.length === records.length) return false;
  writeSeedsAtomic(dbDir, next);
  return true;
}
```

- [ ] **Step 4: Run tests, expect green**

```bash
node --test server/seeds.test.mjs
```

Expected: 9 tests, all pass.

- [ ] **Step 5: Commit**

```bash
git add app/server/seeds.mjs app/server/seeds.test.mjs
git commit -m "feat(seeds): storage layer with slug-uniqueness + atomic writes"
```

---

### Task 3: `loadReport(dataDir, dbDir)` merges seeds in-memory

**Files:**
- Modify: `app/server/data.mjs`
- Modify: `app/server/data.test.mjs`

**Interfaces:**
- Consumes: `readSeeds`, `slugOf` (Task 2).
- Produces:
  - `loadReport(dataDir, dbDir)` (extended signature; old single-arg `loadReport(dataDir)` callers must be migrated in Task 4).
  - Records returned with `curated: true` when they came from seeds; otherwise `curated: false`.
  - On slug collision: seed wins, but null augment fields fall back to the raw-records values (`stars`, `stars_display`, `version`, `contributors`).

- [ ] **Step 1: Write the failing test**

Replace `app/server/data.test.mjs` with:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReport } from "./data.mjs";
import { createApp } from "./app.mjs";

const baseRaw = {
  generated_at: "2026-06-30T00:00:00Z",
  query: "q",
  records: [
    {
      id: "a-b",
      name: "a/b",
      url: "https://github.com/a/b",
      repo_url: "https://github.com/a/b",
      category: "mcp-server",
      stars: 100,
      stars_display: "100",
      version: "v1",
      contributors: 5,
      description: "raw desc",
      efficiency_gain: "raw gain",
      sources: [],
      confidence: "high",
      use_cases: ["dev"],
      last_researched: "2026-06-30",
    },
  ],
};

test("loadReport: no seeds → raw records pass through, curated=false", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "data-"));
  const dbDir = await mkdtemp(join(tmpdir(), "db-"));
  try {
    await writeFile(join(dataDir, "report.json"), JSON.stringify(baseRaw));
    const r = loadReport(dataDir, dbDir);
    assert.equal(r.records.length, 1);
    assert.equal(r.records[0].curated, false);
    assert.equal(r.records[0].description, "raw desc");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
});

test("loadReport: seed-only record appears with curated=true", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "data-"));
  const dbDir = await mkdtemp(join(tmpdir(), "db-"));
  try {
    await writeFile(join(dataDir, "report.json"), JSON.stringify(baseRaw));
    await writeFile(
      join(dbDir, "seeds.json"),
      JSON.stringify({
        records: [
          {
            name: "Obsidian",
            url: "https://obsidian.md",
            category: "companion-app",
            description: "curated",
            efficiency_gain: "curated gain",
            use_cases: ["knowledge-tool"],
            sources: [],
            confidence: "high",
            added_at: "2026-06-30T10:00:00Z",
            updated_at: "2026-06-30T10:00:00Z",
          },
        ],
      }),
    );
    const r = loadReport(dataDir, dbDir);
    const obs = r.records.find((x) => x.name === "Obsidian");
    assert.ok(obs);
    assert.equal(obs.curated, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
});

test("loadReport: seed wins on slug collision; null augment fields fall back to raw", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "data-"));
  const dbDir = await mkdtemp(join(tmpdir(), "db-"));
  try {
    await writeFile(join(dataDir, "report.json"), JSON.stringify(baseRaw));
    await writeFile(
      join(dbDir, "seeds.json"),
      JSON.stringify({
        records: [
          {
            name: "a/b",
            url: "https://github.com/a/b",
            category: "mcp-server",
            description: "OVERRIDE",
            efficiency_gain: "OVERRIDE gain",
            stars: null,
            version: null,
            contributors: null,
            sources: [],
            confidence: "high",
            use_cases: ["dev"],
          },
        ],
      }),
    );
    const r = loadReport(dataDir, dbDir);
    const x = r.records.find((y) => y.name === "a/b");
    assert.equal(x.description, "OVERRIDE", "seed beats raw on description");
    assert.equal(x.stars, 100, "raw stars preserved when seed is null");
    assert.equal(x.version, "v1", "raw version preserved when seed is null");
    assert.equal(x.curated, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
});

test("loadReport: sort order is stars desc with null last", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "data-"));
  const dbDir = await mkdtemp(join(tmpdir(), "db-"));
  try {
    await writeFile(
      join(dataDir, "report.json"),
      JSON.stringify({
        ...baseRaw,
        records: [
          { ...baseRaw.records[0], id: "low", name: "low", stars: 10 },
          { ...baseRaw.records[0], id: "high", name: "high", stars: 1000 },
        ],
      }),
    );
    await writeFile(
      join(dbDir, "seeds.json"),
      JSON.stringify({
        records: [
          {
            name: "no-stars-seed",
            url: "https://x.example",
            category: "companion-app",
            description: "x",
            efficiency_gain: "x",
            stars: null,
            sources: [],
            confidence: "high",
            use_cases: [],
          },
        ],
      }),
    );
    const r = loadReport(dataDir, dbDir);
    assert.deepEqual(
      r.records.map((x) => x.name),
      ["high", "low", "no-stars-seed"],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
});

test("GET /api/records: surfaces curated + merged records", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "app-data-"));
  const dbDir = await mkdtemp(join(tmpdir(), "app-db-"));
  try {
    await writeFile(join(dataDir, "report.json"), JSON.stringify(baseRaw));
    await mkdir(dbDir, { recursive: true });
    await writeFile(
      join(dbDir, "seeds.json"),
      JSON.stringify({
        records: [
          {
            name: "Obsidian",
            url: "https://obsidian.md",
            category: "companion-app",
            description: "d",
            efficiency_gain: "e",
            stars: null,
            sources: [],
            confidence: "high",
            use_cases: [],
            added_at: "2026-06-30T00:00:00Z",
            updated_at: "2026-06-30T00:00:00Z",
          },
        ],
      }),
    );
    const app = createApp({ dataDir, dbDir });
    const res = await app.request("/api/records");
    assert.equal(res.status, 200);
    const body = await res.json();
    const obs = body.records.find((r) => r.name === "Obsidian");
    assert.ok(obs);
    assert.equal(obs.curated, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the tests, watch the new ones fail**

```bash
cd /home/jprentl/projects/claude-ai-tool-report/app
node --test server/data.test.mjs
```

Expected: FAILs because `loadReport` doesn't accept a `dbDir` argument and doesn't merge seeds. The `GET /api/records` test will also fail.

- [ ] **Step 3: Replace `app/server/data.mjs`**

```js
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSeeds, slugOf } from "./seeds.mjs";

const AUGMENT_FIELDS = ["stars", "stars_display", "version", "contributors"];

// loadReport merges three on-disk inputs into the single record set
// the UI consumes:
//   data/report.json  → workflow's verified records (read-only)
//   <dbDir>/seeds.json → user-curated overlay
// Seeds win on slug collision, but null augment fields fall back to
// the raw-records values so a seed without stars doesn't wipe a fresh
// GitHub count.
//
// Each returned record carries curated: boolean so the UI can render
// a badge for seeded entries.
export function loadReport(dataDir, dbDir = null) {
  let raw = { generated_at: null, query: "", records: [] };
  try {
    const j = JSON.parse(readFileSync(join(dataDir, "report.json"), "utf8"));
    raw = {
      generated_at: j.generated_at ?? null,
      query: j.query ?? "",
      records: Array.isArray(j.records) ? j.records : [],
    };
  } catch {
    // missing/unreadable report.json → empty catalogue (boot before workflow)
  }

  const seeds = dbDir ? readSeeds(dbDir) : [];

  // Index raw by slug
  const bySlug = new Map();
  for (const r of raw.records) {
    const s = slugOf(r);
    if (s) bySlug.set(s, { ...r, curated: false });
  }

  for (const seed of seeds) {
    const s = slugOf(seed);
    if (!s) continue;
    const existing = bySlug.get(s);
    if (existing) {
      // Seed wins on user-curated fields, raw wins on augment fields
      // when the seed left them null.
      const merged = { ...existing, ...seed };
      for (const f of AUGMENT_FIELDS) {
        if ((seed[f] === null || seed[f] === undefined) && existing[f] != null) {
          merged[f] = existing[f];
        }
      }
      merged.curated = true;
      bySlug.set(s, merged);
    } else {
      bySlug.set(s, { ...seed, curated: true });
    }
  }

  const records = [...bySlug.values()].sort(
    (a, b) => (b.stars ?? 0) - (a.stars ?? 0),
  );
  return { generated_at: raw.generated_at, query: raw.query, records };
}
```

- [ ] **Step 4: Migrate `app.mjs` to pass `dbDir`**

Open `app/server/app.mjs`. Find the existing `app.get("/api/records", ...)` and `app.post("/api/refresh", ...)` handlers and replace both `loadReport(dataDir)` calls with `loadReport(dataDir, dbDir)`. The handlers around them are unchanged for now:

```js
  app.get("/api/records", (c) => {
    const { generated_at, records } = loadReport(dataDir, dbDir);
    const flags = readFlags(dbDir);
    const merged = records.map((r) => ({
      ...r,
      flagged: Boolean(flags[r.id]?.interesting),
      note: flags[r.id]?.note ?? "",
    }));
    return c.json({ generated_at, records: merged });
  });

  app.post("/api/refresh", (c) => {
    const { generated_at, records } = loadReport(dataDir, dbDir);
    return c.json({ generated_at, count: records.length });
  });
```

The chat handler also calls `loadReport(dataDir)` — change it too:

```js
    const { records } = loadReport(dataDir, dbDir);
```

- [ ] **Step 5: Run tests, expect green**

```bash
node --test server/data.test.mjs server/app.test.mjs server/chat.test.mjs server/flags.test.mjs
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add app/server/data.mjs app/server/data.test.mjs app/server/app.mjs
git commit -m "feat(data): loadReport(dataDir, dbDir) merges seeds in-memory"
```

---

### Task 4: `app/server/enrich.mjs` — auto-fill for the modal preview

**Files:**
- Create: `app/server/enrich.mjs`
- Create: `app/server/enrich.test.mjs`

**Interfaces:**
- Consumes: an injected `llm` client (must expose `chat(messages) → Promise<string>` — already in `app/server/llm/index.mjs`), an injected `fetchImpl` for tests, and `process.env.GITHUB_TOKEN`.
- Produces:
  - `enrichFromUrl({ url, name?, githubToken, llm, fetchImpl? }) → Promise<EnrichedRecord>`
  - `isGithubUrl(url) → boolean` (exported so other callers can reuse).
  - Return shape:
    ```ts
    {
      name: string,
      url: string,
      repo_url: string | null,
      category: "plugin-skill" | "mcp-server" | "token-tool" | "companion-app",
      description: string,
      efficiency_gain: string,
      use_cases: string[],
      sources: string[],
      confidence: "high" | "medium" | "low",
      stars: number | null,
      stars_display: string | null,
      version: string | null,
      contributors: number | null,
      free: boolean | null,        // LLM's free-tier judgment; null when not assessed (github path)
      free_check_reason: string | null,
    }
    ```

- [ ] **Step 1: Write the failing test**

Create `app/server/enrich.test.mjs`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichFromUrl, isGithubUrl } from "./enrich.mjs";

test("isGithubUrl: matches https github repo url", () => {
  assert.equal(isGithubUrl("https://github.com/foo/bar"), true);
  assert.equal(isGithubUrl("https://github.com/foo/bar/tree/main"), true);
  assert.equal(isGithubUrl("https://obsidian.md"), false);
  assert.equal(isGithubUrl("https://github.com/foo"), false);
});

test("enrichFromUrl: github path fills stars/version/contributors", async () => {
  const fetchImpl = async (u) => {
    if (u.endsWith("/repos/foo/bar")) {
      return new Response(
        JSON.stringify({
          stargazers_count: 1234,
          description: "from gh",
          license: { spdx_id: "MIT" },
          topics: ["claude-code", "rag"],
        }),
        { status: 200 },
      );
    }
    if (u.includes("/releases/latest")) {
      return new Response(JSON.stringify({ tag_name: "v2.0.0" }), { status: 200 });
    }
    if (u.includes("/contributors")) {
      return new Response("[]", {
        status: 200,
        headers: { link: '<...&page=42>; rel="last"' },
      });
    }
    throw new Error("unexpected " + u);
  };
  const out = await enrichFromUrl({
    url: "https://github.com/foo/bar",
    githubToken: "ghp_x",
    llm: null,
    fetchImpl,
  });
  assert.equal(out.name, "foo/bar");
  assert.equal(out.url, "https://github.com/foo/bar");
  assert.equal(out.repo_url, "https://github.com/foo/bar");
  assert.equal(out.stars, 1234);
  assert.equal(out.stars_display, "1.2k");
  assert.equal(out.version, "v2.0.0");
  assert.equal(out.contributors, 42);
  assert.equal(out.description, "from gh");
  // No LLM call on the github path → free is null
  assert.equal(out.free, null);
});

test("enrichFromUrl: homepage path runs LLM extraction", async () => {
  const fetchImpl = async (u) => {
    if (u === "https://obsidian.md") {
      return new Response("<html><body>Obsidian: free markdown PKM</body></html>", {
        status: 200,
      });
    }
    throw new Error("unexpected fetch " + u);
  };
  const llmCalls = [];
  const llm = {
    chat: async (messages) => {
      llmCalls.push(messages);
      return JSON.stringify({
        description: "Local-first Markdown knowledge base",
        efficiency_gain: "External memory layer for Claude",
        use_cases: ["knowledge-tool", "note-taking", "rag"],
        category: "companion-app",
        free: true,
        free_check_reason: "Homepage shows 'Free for personal use'",
      });
    },
  };
  const out = await enrichFromUrl({
    url: "https://obsidian.md",
    name: "Obsidian",
    githubToken: "ghp_x",
    llm,
    fetchImpl,
  });
  assert.equal(out.name, "Obsidian");
  assert.equal(out.url, "https://obsidian.md");
  assert.equal(out.repo_url, null);
  assert.equal(out.category, "companion-app");
  assert.equal(out.free, true);
  assert.match(out.description, /knowledge base/);
  assert.equal(llmCalls.length, 1);
});

test("enrichFromUrl: homepage LLM returns invalid JSON → throws", async () => {
  const fetchImpl = async () => new Response("<html></html>", { status: 200 });
  const llm = { chat: async () => "this is not json" };
  await assert.rejects(
    () => enrichFromUrl({ url: "https://example.com", llm, fetchImpl }),
    /enrich/i,
  );
});

test("enrichFromUrl: github 404 → throws", async () => {
  const fetchImpl = async () => new Response("not found", { status: 404 });
  await assert.rejects(
    () =>
      enrichFromUrl({
        url: "https://github.com/missing/repo",
        githubToken: "ghp_x",
        llm: null,
        fetchImpl,
      }),
    /repo not found|404/i,
  );
});
```

- [ ] **Step 2: Run, watch fail**

```bash
node --test server/enrich.test.mjs
```

Expected: FAIL — module missing.

- [ ] **Step 3: Implement `enrich.mjs`**

Create `app/server/enrich.mjs`:

```js
// Auto-fill helper for the "Add Tool" modal preview step.
//
// Branches on the URL host:
//   github.com/{owner}/{repo} → REST API for stars/version/contributors
//                                 + description + license + topics.
//                                 LLM is NOT called; the modal pre-fills
//                                 efficiency_gain/use_cases from topics
//                                 and the repo description, and the user
//                                 edits them.
//   anything else            → WebFetch homepage HTML + single LLM call
//                                 with a strict JSON schema asking for
//                                 description, efficiency_gain, use_cases,
//                                 category, and a free-tier boolean.
//
// All outbound fetch goes via the global undici dispatcher set in
// index.mjs, so HTTPS_PROXY is respected.
const GITHUB_RE = /^https:\/\/github\.com\/([^/]+)\/([^/?#]+)/i;

export function isGithubUrl(url) {
  if (typeof url !== "string") return false;
  return GITHUB_RE.test(url);
}

function formatStars(n) {
  if (n == null) return null;
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `~${Math.round(n / 1000)}k`;
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "claude-ai-tool-research",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchRepoMeta(slug, token, fetchImpl) {
  const r = await fetchImpl(`https://api.github.com/repos/${slug}`, {
    headers: githubHeaders(token),
  });
  if (r.status === 404) throw new Error(`github repo not found: ${slug}`);
  if (!r.ok) throw new Error(`github upstream failed: ${r.status}`);
  return await r.json();
}

async function fetchVersion(slug, token, fetchImpl) {
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: githubHeaders(token),
    });
    if (r.ok) {
      const j = await r.json();
      return j.tag_name || j.name || null;
    }
    const t = await fetchImpl(
      `https://api.github.com/repos/${slug}/tags?per_page=1`,
      { headers: githubHeaders(token) },
    );
    if (!t.ok) return null;
    const tags = await t.json();
    return Array.isArray(tags) && tags[0]?.name ? tags[0].name : null;
  } catch {
    return null;
  }
}

async function fetchContributors(slug, token, fetchImpl) {
  try {
    const r = await fetchImpl(
      `https://api.github.com/repos/${slug}/contributors?per_page=1&anon=true`,
      { headers: githubHeaders(token) },
    );
    if (!r.ok) return null;
    const link = r.headers.get("link") || "";
    const m = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
    if (m) return Number.parseInt(m[1], 10);
    const body = await r.json();
    return Array.isArray(body) ? body.length : null;
  } catch {
    return null;
  }
}

const LLM_SYSTEM =
  "You extract structured product metadata from web pages for a research catalogue. " +
  "Reply with valid JSON only — no prose, no markdown fences.";

const LLM_SCHEMA_HINT =
  '{"description": string, "efficiency_gain": string, ' +
  '"use_cases": string[], ' +
  '"category": "plugin-skill" | "mcp-server" | "token-tool" | "companion-app", ' +
  '"free": boolean, "free_check_reason": string}';

function buildLlmPrompt(url, name, html) {
  return [
    {
      role: "system",
      content: LLM_SYSTEM,
    },
    {
      role: "user",
      content:
        `Tool homepage: ${url}\n` +
        (name ? `Suspected name: ${name}\n` : "") +
        `Below is the HTML. Extract metadata that helps a Claude Code user decide whether the tool is worth installing.\n\n` +
        `Required JSON shape: ${LLM_SCHEMA_HINT}\n\n` +
        `Rules:\n` +
        `- description: one sentence, neutral, factual.\n` +
        `- efficiency_gain: one line — how it boosts Claude Code productivity.\n` +
        `- use_cases: 1–5 lowercase-hyphen tags from {research, development, ` +
        `token-efficiency, brainstorming, automation, docs, debugging, ` +
        `ui-design, rag, knowledge-tool, note-taking, local-llm, ai-editor, ` +
        `ai-plugin, memory, free}. You may mint new lowercase-hyphen tags.\n` +
        `- category: best fit from the four enum values.\n` +
        `- free: true ONLY if the homepage explicitly offers a free tier ` +
        `with no AI-feature quota or open-source licence; false otherwise.\n` +
        `- free_check_reason: one phrase quoting evidence from the page.\n\n` +
        `HTML (truncated to 60KB):\n` +
        String(html).slice(0, 60000),
    },
  ];
}

async function fetchHomepageHtml(url, fetchImpl) {
  const r = await fetchImpl(url, {
    headers: { "User-Agent": "claude-ai-tool-research", Accept: "text/html,*/*" },
  });
  if (!r.ok) throw new Error(`homepage fetch failed: ${r.status}`);
  return await r.text();
}

function parseLlmJson(text) {
  // Some models still wrap JSON in ``` fences; strip and try once.
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`enrich: LLM did not return valid JSON: ${err.message}`);
  }
}

export async function enrichFromUrl({
  url,
  name,
  githubToken,
  llm,
  fetchImpl = fetch,
}) {
  if (typeof url !== "string" || !url.trim()) throw new Error("url required");

  if (isGithubUrl(url)) {
    const m = url.match(GITHUB_RE);
    const slug = `${m[1]}/${m[2].replace(/\.git$/, "")}`.toLowerCase();
    const [meta, version, contributors] = await Promise.all([
      fetchRepoMeta(slug, githubToken, fetchImpl),
      fetchVersion(slug, githubToken, fetchImpl),
      fetchContributors(slug, githubToken, fetchImpl),
    ]);
    return {
      name: name || slug,
      url,
      repo_url: url,
      category: "plugin-skill", // default; user adjusts in modal
      description: meta.description || "",
      efficiency_gain: "",
      use_cases: Array.isArray(meta.topics)
        ? meta.topics.filter((t) => typeof t === "string").slice(0, 8)
        : [],
      sources: [url],
      confidence: "high",
      stars: meta.stargazers_count ?? null,
      stars_display: formatStars(meta.stargazers_count),
      version,
      contributors,
      free: null,
      free_check_reason: null,
    };
  }

  if (!llm) throw new Error("enrich: non-github URL requires an LLM client");
  const html = await fetchHomepageHtml(url, fetchImpl);
  const reply = await llm.chat(buildLlmPrompt(url, name, html));
  const parsed = parseLlmJson(reply);
  return {
    name: name || parsed.name || new URL(url).hostname,
    url,
    repo_url: null,
    category: parsed.category ?? "companion-app",
    description: parsed.description ?? "",
    efficiency_gain: parsed.efficiency_gain ?? "",
    use_cases: Array.isArray(parsed.use_cases) ? parsed.use_cases : [],
    sources: [url],
    confidence: "medium",
    stars: null,
    stars_display: null,
    version: null,
    contributors: null,
    free: typeof parsed.free === "boolean" ? parsed.free : null,
    free_check_reason: parsed.free_check_reason ?? null,
  };
}
```

- [ ] **Step 4: Run, expect green**

```bash
node --test server/enrich.test.mjs
```

Expected: 5 tests pass.

- [ ] **Step 5: Commit**

```bash
git add app/server/enrich.mjs app/server/enrich.test.mjs
git commit -m "feat(enrich): GitHub REST + homepage LLM extraction helper"
```

---

### Task 5: `indexRecord()` — single-record RAG indexer

**Files:**
- Modify: `app/server/embeddings/backfill.mjs`

**Interfaces:**
- Consumes: existing helpers in `backfill.mjs` and `source.mjs`.
- Produces:
  - `export async function indexRecord(record, { client, store, config, fetchReadmeFn?, splitMd?, log? }): Promise<{ embedded, skipped, failed }>` — embeds the single record's chunks. Same text-hash-gated idempotency as the boot-time backfill.

This task only adds a thin wrapper that calls back into the loop body of `runBackfill`. No behavior change for the boot path.

- [ ] **Step 1: Write the failing test**

Append to `app/server/embeddings/backfill.test.mjs`:

```js
test("indexRecord: embeds a single record's chunks", async () => {
  const dir = tmp();
  try {
    const store = createEmbeddingsStore({
      dbPath: join(dir, "x.sqlite"),
      model: "m",
      promptVersion: 1,
    });
    const { indexRecord } = await import("./backfill.mjs");
    const result = await indexRecord(
      { ...RECORD, id: "single", name: "single/repo" },
      {
        client: makeClient(),
        store,
        config: CFG,
        fetchReadmeFn: async () => null,
        log: QUIET_LOG,
      },
    );
    assert.equal(result.embedded, 1);
    assert.equal(store.count(), 1);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run, watch fail**

```bash
node --test server/embeddings/backfill.test.mjs
```

Expected: FAIL — `indexRecord is not a function`.

- [ ] **Step 3: Refactor `backfill.mjs` to expose `indexRecord`**

Open `app/server/embeddings/backfill.mjs`. The current loop body inside `runBackfill` is the exact logic we want; extract it into its own function and have `runBackfill` call it.

Add this function inside the file (after the existing helpers but before `runBackfill`):

```js
// indexRecord embeds the chunks for a single record using the same
// idempotent text_hash gate as the boot-time backfill. Used by both:
//   - runBackfill (the boot loop)
//   - app.mjs POST /api/seeds (async via setImmediate)
//
// Returns per-record counters so callers can log meaningfully.
export async function indexRecord(rec, {
  client,
  store,
  config,
  fetchReadmeFn = defaultFetchReadme,
  splitMd = defaultSplitMd,
  log = console,
}) {
  let embedded = 0;
  let skipped = 0;
  let failed = 0;
  try {
    const fields = buildFieldsChunk(rec);
    const candidates = [{ ...fields, chunkIndex: 0 }];

    if (config.githubToken) {
      const slug = repoSlugFromRecord(rec);
      const md = slug
        ? await fetchReadmeFn({ repoSlug: slug, githubToken: config.githubToken })
        : null;
      if (md) {
        const readmeChunks = splitMd(md, slug, config.chunkMaxChars);
        readmeChunks.forEach((c, i) =>
          candidates.push({
            source: "readme",
            headingPath: c.headingPath,
            text: c.text,
            chunkIndex: i + 1,
          }),
        );
      }
    }

    const needEmbed = [];
    for (const c of candidates) {
      const textHash = sha256(c.text);
      if (store.hasChunkWithHash(rec.id, c.chunkIndex, textHash)) {
        skipped++;
        continue;
      }
      needEmbed.push({ ...c, textHash });
    }
    if (!needEmbed.length) return { embedded, skipped, failed };

    for (let i = 0; i < needEmbed.length; i += config.batchSize) {
      const batch = needEmbed.slice(i, i + config.batchSize);
      const vectors = await client.embedBatch(batch.map((b) => b.text));
      const rows = batch.map((b, j) => ({
        recordId: rec.id,
        chunkIndex: b.chunkIndex,
        source: b.source,
        headingPath: b.headingPath ?? null,
        text: b.text,
        textHash: b.textHash,
        vector: vectors[j],
      }));
      store.upsertChunks(rows);
      embedded += rows.length;
    }
    log.info?.(`[index] ${rec.id} embedded=${embedded} skipped=${skipped}`);
  } catch (err) {
    failed++;
    log.warn?.(`[index] ${rec.id} failed: ${err.message}`);
  }
  return { embedded, skipped, failed };
}
```

Now refactor `runBackfill` to use it. Replace the per-record loop body (everything inside the existing `for (const rec of records)` block) with:

```js
  for (const rec of records) {
    const r = await indexRecord(rec, { client, store, config, fetchReadmeFn, splitMd, log });
    embedded += r.embedded;
    skipped += r.skipped;
    failed += r.failed;
  }
```

- [ ] **Step 4: Run all backfill tests, expect green**

```bash
node --test server/embeddings/backfill.test.mjs
```

Expected: all existing tests + the new `indexRecord` test pass.

- [ ] **Step 5: Commit**

```bash
git add app/server/embeddings/backfill.mjs app/server/embeddings/backfill.test.mjs
git commit -m "feat(rag): expose indexRecord() for single-record async indexing"
```

---

### Task 6: API endpoints — enrich + CRUD on seeds

**Files:**
- Modify: `app/server/app.mjs`
- Modify: `app/server/app.test.mjs`

**Interfaces:**
- Consumes: `seeds.mjs` (Task 2), `enrich.mjs` (Task 4), `indexRecord` (Task 5), `loadReport` (Task 3).
- Produces:
  - `POST /api/seeds/enrich`
  - `POST /api/seeds`
  - `PATCH /api/seeds/:slug`
  - `DELETE /api/seeds/:slug`
  - `createApp` gains optional dependencies in `opts`: `{ ..., enrich?, indexer? }` so tests can inject fakes.

- [ ] **Step 1: Write the failing tests**

Append to `app/server/app.test.mjs`:

```js
test("POST /api/seeds/enrich: returns preview without saving", async () => {
  const enrich = async (input) => ({
    name: input.name || "X",
    url: input.url,
    repo_url: null,
    category: "companion-app",
    description: "preview desc",
    efficiency_gain: "preview gain",
    use_cases: ["test"],
    sources: [input.url],
    confidence: "medium",
    stars: null,
    stars_display: null,
    version: null,
    contributors: null,
    free: true,
    free_check_reason: "preview",
  });
  const dbDir = await mkdtemp(join(tmpdir(), "app-db-"));
  const dataDir = await mkdtemp(join(tmpdir(), "app-data-"));
  try {
    const app = createApp({ dataDir, dbDir, enrich });
    const res = await app.request("/api/seeds/enrich", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: "https://example.com", name: "Example" }),
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.enriched.name, "Example");
    assert.equal(body.enriched.category, "companion-app");
    // Did NOT save
    const list = await app.request("/api/records");
    const listBody = await list.json();
    assert.equal(listBody.records.length, 0);
  } finally {
    await rm(dbDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /api/seeds: validates required fields", async () => {
  const dbDir = await mkdtemp(join(tmpdir(), "app-db-"));
  const dataDir = await mkdtemp(join(tmpdir(), "app-data-"));
  try {
    const app = createApp({ dataDir, dbDir });
    const res = await app.request("/api/seeds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Only name" }),
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.match(body.error, /url/i);
  } finally {
    await rm(dbDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /api/seeds: saves a valid seed + invokes indexer", async () => {
  const dbDir = await mkdtemp(join(tmpdir(), "app-db-"));
  const dataDir = await mkdtemp(join(tmpdir(), "app-data-"));
  let indexedRec = null;
  const indexer = (rec) => {
    indexedRec = rec;
  };
  try {
    const app = createApp({ dataDir, dbDir, indexer });
    const res = await app.request("/api/seeds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Obsidian",
        url: "https://obsidian.md",
        category: "companion-app",
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.equal(body.seed.name, "Obsidian");
    // indexer should have been scheduled (we await one microtask)
    await new Promise((r) => setImmediate(r));
    assert.ok(indexedRec, "indexer was called");
    assert.equal(indexedRec.name, "Obsidian");
  } finally {
    await rm(dbDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /api/seeds: 409 with existing='seed' on duplicate", async () => {
  const dbDir = await mkdtemp(join(tmpdir(), "app-db-"));
  const dataDir = await mkdtemp(join(tmpdir(), "app-data-"));
  try {
    const app = createApp({ dataDir, dbDir });
    const body = JSON.stringify({
      name: "Obsidian",
      url: "https://obsidian.md",
      category: "companion-app",
    });
    const opts = { method: "POST", headers: { "content-type": "application/json" }, body };
    await app.request("/api/seeds", opts);
    const res = await app.request("/api/seeds", opts);
    assert.equal(res.status, 409);
    const j = await res.json();
    assert.equal(j.existing, "seed");
  } finally {
    await rm(dbDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("POST /api/seeds: 409 with existing='raw' when slug already in raw-records", async () => {
  const dbDir = await mkdtemp(join(tmpdir(), "app-db-"));
  const dataDir = await mkdtemp(join(tmpdir(), "app-data-"));
  try {
    await writeFile(
      join(dataDir, "report.json"),
      JSON.stringify({
        generated_at: "t",
        records: [
          {
            id: "x-y",
            name: "x/y",
            url: "https://github.com/x/y",
            repo_url: "https://github.com/x/y",
            category: "plugin-skill",
            description: "",
            efficiency_gain: "",
            use_cases: [],
            sources: [],
            confidence: "high",
          },
        ],
      }),
    );
    const app = createApp({ dataDir, dbDir });
    const res = await app.request("/api/seeds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "x/y",
        url: "https://github.com/x/y",
        category: "plugin-skill",
      }),
    });
    assert.equal(res.status, 409);
    const j = await res.json();
    assert.equal(j.existing, "raw");
  } finally {
    await rm(dbDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("PATCH /api/seeds/:slug updates a seed", async () => {
  const dbDir = await mkdtemp(join(tmpdir(), "app-db-"));
  const dataDir = await mkdtemp(join(tmpdir(), "app-data-"));
  try {
    const app = createApp({ dataDir, dbDir });
    await app.request("/api/seeds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Obsidian",
        url: "https://obsidian.md",
        category: "companion-app",
      }),
    });
    const res = await app.request("/api/seeds/obsidian", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ description: "updated" }),
    });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.seed.description, "updated");
  } finally {
    await rm(dbDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("DELETE /api/seeds/:slug removes a seed", async () => {
  const dbDir = await mkdtemp(join(tmpdir(), "app-db-"));
  const dataDir = await mkdtemp(join(tmpdir(), "app-data-"));
  try {
    const app = createApp({ dataDir, dbDir });
    await app.request("/api/seeds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "Obsidian",
        url: "https://obsidian.md",
        category: "companion-app",
      }),
    });
    const res = await app.request("/api/seeds/obsidian", { method: "DELETE" });
    assert.equal(res.status, 200);
    const j = await res.json();
    assert.equal(j.deleted, true);
  } finally {
    await rm(dbDir, { recursive: true, force: true });
    await rm(dataDir, { recursive: true, force: true });
  }
});
```

Also at the top of `app.test.mjs`, ensure these imports exist (add what's missing):

```js
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
```

- [ ] **Step 2: Run, watch fail**

```bash
node --test server/app.test.mjs
```

Expected: FAIL — the new routes return 404.

- [ ] **Step 3: Implement the new routes in `app.mjs`**

Open `app/server/app.mjs`. At the top, add the new imports:

```js
import { addSeed, updateSeed, deleteSeed, slugOf, readSeeds } from "./seeds.mjs";
import { enrichFromUrl } from "./enrich.mjs";
```

Extend the `createApp` signature to accept `enrich` and `indexer`:

```js
export function createApp(opts = {}) {
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? "../data";
  const dbDir = opts.dbDir ?? process.env.DB_DIR ?? "./db";
  const llm = opts.llm ?? null;
  const retriever = opts.retriever ?? null;
  const embeddingsCfg = opts.embeddingsCfg ?? { enabled: false };
  // enrich: pluggable for tests; production wires the real helper.
  const enrich = opts.enrich ?? ((input) =>
    enrichFromUrl({
      url: input.url,
      name: input.name,
      githubToken: process.env.GITHUB_TOKEN,
      llm,
    }));
  // indexer: a fire-and-forget function called after a seed is saved.
  // Defaults to a no-op so tests don't need to provide one for the
  // record-shape assertions.
  const indexer = opts.indexer ?? null;
```

Add the four new routes at the bottom of the existing route list (just before `return app;`):

```js
  const CATS = new Set(["plugin-skill", "mcp-server", "token-tool", "companion-app"]);

  function validateSeedPayload(body) {
    if (!body || typeof body !== "object") return "body must be a JSON object";
    if (typeof body.name !== "string" || !body.name.trim()) return "name required";
    if (typeof body.url !== "string" || !body.url.trim()) return "url required";
    try {
      const u = new URL(body.url);
      if (!/^https?:$/.test(u.protocol)) return "url must be http or https";
    } catch {
      return "url is not a valid URL";
    }
    if (!CATS.has(body.category)) {
      return `category must be one of ${[...CATS].join(" | ")}`;
    }
    return null;
  }

  app.post("/api/seeds/enrich", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (!body?.url) return c.json({ error: "url required" }, 400);
    try {
      const enriched = await enrich({ url: body.url, name: body.name });
      return c.json({ enriched });
    } catch (err) {
      console.error("[/api/seeds/enrich]", err);
      return c.json({ error: err.message || "enrich failed" }, 502);
    }
  });

  app.post("/api/seeds", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const err = validateSeedPayload(body);
    if (err) return c.json({ error: err }, 400);
    const slug = slugOf(body);
    if (!slug) return c.json({ error: "could not derive a slug" }, 400);
    // Collision check against raw-records (workflow output)
    const { records: existingMerged } = loadReport(dataDir, dbDir);
    const inRaw = existingMerged.some((r) => slugOf(r) === slug && !r.curated);
    if (inRaw) return c.json({ existing: "raw" }, 409);
    try {
      const { seed } = addSeed(dbDir, {
        name: body.name,
        url: body.url,
        repo_url: body.repo_url ?? null,
        category: body.category,
        description: body.description ?? "",
        efficiency_gain: body.efficiency_gain ?? "",
        use_cases: Array.isArray(body.use_cases) ? body.use_cases : [],
        sources: Array.isArray(body.sources) ? body.sources : [body.url],
        confidence: body.confidence ?? "high",
        stars: body.stars ?? null,
        stars_display: body.stars_display ?? null,
        version: body.version ?? null,
        contributors: body.contributors ?? null,
      });
      if (indexer) {
        setImmediate(() => {
          try {
            // indexer may be sync (in tests) or async; either works.
            indexer({ ...seed, id: slug });
          } catch (e) {
            console.error("[index] failed:", e);
          }
        });
      }
      return c.json({ seed }, 201);
    } catch (e) {
      if (String(e.message).includes("SLUG_EXISTS_SEED")) {
        return c.json({ existing: "seed" }, 409);
      }
      console.error("[/api/seeds POST]", e);
      return c.json({ error: "failed to save seed" }, 500);
    }
  });

  app.patch("/api/seeds/:slug", async (c) => {
    const slug = c.req.param("slug");
    const patch = await c.req.json().catch(() => ({}));
    if (patch.category !== undefined && !CATS.has(patch.category)) {
      return c.json({ error: "invalid category" }, 400);
    }
    try {
      const { seed } = updateSeed(dbDir, slug, patch);
      if (indexer) {
        setImmediate(() => {
          try {
            indexer({ ...seed, id: slug });
          } catch (e) {
            console.error("[index] failed:", e);
          }
        });
      }
      return c.json({ seed });
    } catch (e) {
      if (String(e.message).includes("NO_SUCH_SEED")) {
        return c.json({ error: "seed not found" }, 404);
      }
      console.error("[/api/seeds PATCH]", e);
      return c.json({ error: "failed to update seed" }, 500);
    }
  });

  app.delete("/api/seeds/:slug", (c) => {
    const slug = c.req.param("slug");
    const removed = deleteSeed(dbDir, slug);
    if (!removed) return c.json({ error: "seed not found" }, 404);
    return c.json({ deleted: true });
  });
```

- [ ] **Step 4: Run, expect green**

```bash
node --test server/app.test.mjs
```

Expected: all (existing + 7 new) pass.

- [ ] **Step 5: Commit**

```bash
git add app/server/app.mjs app/server/app.test.mjs
git commit -m "feat(api): POST/PATCH/DELETE /api/seeds + POST /api/seeds/enrich"
```

---

### Task 7: Wire enrich + indexer into the boot path

**Files:**
- Modify: `app/server/index.mjs`

**Interfaces:**
- Consumes: `enrich.mjs` (Task 4), `indexRecord` (Task 5), existing client/store wiring.
- Produces: a `createApp(...)` invocation with real `enrich` and `indexer` for production. Tests already cover the injection-points individually.

- [ ] **Step 1: Edit `index.mjs`**

At the top, add the imports:

```js
import { enrichFromUrl } from "./enrich.mjs";
import { runBackfill, indexRecord } from "./embeddings/backfill.mjs";
```

(The `indexRecord` import is new; `runBackfill` was already imported.)

Just before `const app = createApp({ ... })`, add:

```js
// Real enrich: closes over the LLM client and the GITHUB_TOKEN env var.
const enrich = (input) =>
  enrichFromUrl({
    url: input.url,
    name: input.name,
    githubToken: process.env.GITHUB_TOKEN,
    llm,
  });

// Real indexer: fires when POST /api/seeds saves a record. Same client,
// store, config as the boot backfill — the text_hash gate makes
// concurrent boot + indexer safe.
const indexer = retriever
  ? (rec) => {
      indexRecord(rec, {
        client: retriever.client ?? null,
        store: retriever.store ?? null,
        config: embeddingsCfg,
      }).catch((err) => console.error("[index] failed:", err));
    }
  : null;
```

Wait — `retriever` doesn't expose `client` and `store` directly. We need to thread them. Refactor the boot block:

```js
let retriever = null;
let embClient = null;
let embStore = null;
if (embeddingsCfg.enabled) {
  const oauth = createOAuthClient({ ...embeddingsCfg.auth, fetchImpl: fetch });
  embClient = createEmbeddingsClient({ getConfig: () => embeddingsCfg, oauth });
  embStore = createEmbeddingsStore({
    dbPath: join(dbDir, "embeddings.sqlite"),
    model: embeddingsCfg.model,
    promptVersion: embeddingsCfg.promptVersion,
  });
  if (embeddingsCfg.backfillOnStartup) {
    const { records } = loadReport(dataDir, dbDir);
    console.log(`[boot] embeddings backfill starting for ${records.length} records…`);
    const result = await runBackfill({
      records,
      client: embClient,
      store: embStore,
      config: embeddingsCfg,
    });
    console.log(
      `[boot] embeddings backfill: embedded=${result.embedded} skipped=${result.skipped} failed=${result.failed} pruned=${result.pruned}`,
    );
  }
  retriever = createRetriever({ client: embClient, store: embStore, config: embeddingsCfg });
}

const enrich = (input) =>
  enrichFromUrl({
    url: input.url,
    name: input.name,
    githubToken: process.env.GITHUB_TOKEN,
    llm,
  });

const indexer = embClient && embStore
  ? (rec) =>
      indexRecord(rec, {
        client: embClient,
        store: embStore,
        config: embeddingsCfg,
      }).catch((err) => console.error("[index] failed:", err))
  : null;

const app = createApp({ dataDir, dbDir, llm, retriever, embeddingsCfg, enrich, indexer });
```

Also: `loadReport(dataDir)` at the boot block was passing one arg. Change to `loadReport(dataDir, dbDir)` so the boot backfill sees the seeded records too. (Without this, a brand-new seed isn't embedded until the user adds it via the UI — which is the documented async path, so the change is for symmetry, not correctness.)

- [ ] **Step 2: Syntax + boot smoke**

```bash
cd /home/jprentl/projects/claude-ai-tool-report/app
node --check server/index.mjs
```

Expected: no output (parse OK).

- [ ] **Step 3: Commit**

```bash
git add app/server/index.mjs
git commit -m "feat(server): wire enrich + indexer into createApp at boot"
```

---

### Task 8: Frontend types + api helpers

**Files:**
- Modify: `app/web/types.ts`
- Modify: `app/web/api.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `Rec` gains `curated: boolean`.
  - `Seed` and `EnrichedRecord` types.
  - `api.enrichTool(payload)`, `api.addTool(payload)`, `api.updateTool(slug, patch)`, `api.deleteTool(slug)`. Each throws an `ApiError` (a small class) with `status` and (for 409) `body.existing`.

- [ ] **Step 1: Edit `types.ts`**

Open `app/web/types.ts`. Replace the contents with:

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
  curated: boolean;
}

export interface EnrichedRecord {
  name: string;
  url: string;
  repo_url: string | null;
  category: Rec["category"];
  description: string;
  efficiency_gain: string;
  use_cases: string[];
  sources: string[];
  confidence: "high" | "medium" | "low";
  stars: number | null;
  stars_display: string | null;
  version: string | null;
  contributors: number | null;
  free: boolean | null;
  free_check_reason: string | null;
}

export type ChatScope = "record" | "selection" | "global";
```

- [ ] **Step 2: Edit `api.ts`**

Replace the contents of `app/web/api.ts`:

```ts
import type { Rec, ChatScope, EnrichedRecord } from "./types";

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(`${status} ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export const api = {
  getRecords: () =>
    jsonFetch<{ generated_at: string | null; records: Rec[] }>("/api/records"),
  refresh: () =>
    jsonFetch<{ generated_at: string | null; count: number }>("/api/refresh", {
      method: "POST",
    }),
  setFlag: (id: string, patch: { interesting?: boolean; note?: string }) =>
    jsonFetch(`/api/records/${encodeURIComponent(id)}/flag`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  chat: (scope: ChatScope, ids: string[], message: string) =>
    jsonFetch<{ answer?: string; error?: string; retrieval?: unknown }>("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, ids, message }),
    }),
  enrichTool: (payload: { url: string; name?: string }) =>
    jsonFetch<{ enriched: EnrichedRecord }>("/api/seeds/enrich", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  addTool: (payload: Partial<EnrichedRecord> & { url: string; name: string; category: Rec["category"] }) =>
    jsonFetch<{ seed: Rec }>("/api/seeds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  updateTool: (slug: string, patch: Partial<EnrichedRecord>) =>
    jsonFetch<{ seed: Rec }>(`/api/seeds/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  deleteTool: (slug: string) =>
    jsonFetch<{ deleted: true }>(`/api/seeds/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    }),
};
```

- [ ] **Step 3: Typecheck**

```bash
cd /home/jprentl/projects/claude-ai-tool-report/app
npx tsc --noEmit -p tsconfig.json 2>&1 | head -20
```

Expected: no new errors. (Existing files that depend on `Rec` are unchanged because `curated` is added, not renamed.)

- [ ] **Step 4: Commit**

```bash
git add app/web/types.ts app/web/api.ts
git commit -m "feat(web): types + api helpers for seed CRUD"
```

---

### Task 9: Curated badge in the Name column

**Files:**
- Modify: `app/web/columns.tsx`

**Interfaces:**
- Consumes: `Rec.curated` (Task 8), existing `GithubIcon`, `GlobeIcon`, `isGithubUrl`.
- Produces: column visually shows ⭐ before the link when curated.

- [ ] **Step 1: Patch the Name column cell**

Open `app/web/columns.tsx`. Find the `accessorKey: "name"` block. Replace the cell function with:

```tsx
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
          {r.curated && (
            <span
              className="text-accent-bright"
              title="Curated — added via 'Add Tool'"
              aria-label="Curated record"
            >
              ★
            </span>
          )}
          <Icon />
          {info.getValue() as string}
        </a>
      );
    },
```

- [ ] **Step 2: Typecheck**

```bash
cd /home/jprentl/projects/claude-ai-tool-report/app
npx tsc --noEmit -p tsconfig.json 2>&1 | head -10
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/web/columns.tsx
git commit -m "feat(web): ⭐ curated badge in Name column"
```

---

### Task 10: `AddToolModal` component + toolbar button

**Files:**
- Create: `app/web/AddToolModal.tsx`
- Modify: `app/web/App.tsx`

**Interfaces:**
- Consumes: `api.enrichTool`, `api.addTool`, `ApiError`, `EnrichedRecord`, `Rec` (Task 8).
- Produces:
  - `<AddToolModal open onClose onAdded />` — state machine `idle → fetching → preview → saving → success` with `error` overlay.
  - In `App.tsx`, a "+ Add Tool" button next to the existing filters opens the modal. On `onAdded` we reload `/api/records`.

- [ ] **Step 1: Create `AddToolModal.tsx`**

```tsx
import { useState } from "react";
import { api, ApiError } from "./api";
import type { EnrichedRecord, Rec } from "./types";

type Stage = "idle" | "fetching" | "preview" | "saving";

const CATEGORIES: Rec["category"][] = [
  "plugin-skill",
  "mcp-server",
  "token-tool",
  "companion-app",
];

export function AddToolModal({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [stage, setStage] = useState<Stage>("idle");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<EnrichedRecord | null>(null);
  const [error, setError] = useState<string>("");

  function reset() {
    setStage("idle");
    setUrl("");
    setName("");
    setPreview(null);
    setError("");
  }

  async function fetchPreview() {
    setStage("fetching");
    setError("");
    try {
      const { enriched } = await api.enrichTool({ url: url.trim(), name: name.trim() || undefined });
      setPreview(enriched);
      setStage("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setStage("idle");
    }
  }

  async function save() {
    if (!preview) return;
    setStage("saving");
    setError("");
    try {
      await api.addTool({
        name: preview.name,
        url: preview.url,
        repo_url: preview.repo_url,
        category: preview.category,
        description: preview.description,
        efficiency_gain: preview.efficiency_gain,
        use_cases: preview.use_cases,
        sources: preview.sources,
        confidence: preview.confidence,
        stars: preview.stars,
        stars_display: preview.stars_display,
        version: preview.version,
        contributors: preview.contributors,
      });
      onAdded();
      reset();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const existing = String(err.body.existing ?? "");
        setError(
          existing === "raw"
            ? "The crawler already lists this tool — no need to add it manually."
            : "You've already curated this tool — edit it in its detail panel.",
        );
      } else {
        setError(err instanceof Error ? err.message : "Unknown error");
      }
      setStage("preview");
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded border border-edge bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-mono text-base tracking-widest uppercase text-primary">Add Tool</h2>
          <button
            onClick={() => {
              reset();
              onClose();
            }}
            className="font-mono text-muted hover:text-primary"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {stage === "idle" || stage === "fetching" ? (
          <div className="space-y-3">
            <label className="block font-mono text-[11px] text-muted uppercase tracking-widest">
              URL
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/owner/repo or https://example.com"
                className="mt-1 w-full rounded bg-raised border border-edge px-3 py-1.5 text-sm text-primary placeholder:text-dim focus:outline-none focus:ring-1 focus:ring-accent"
                autoFocus
              />
            </label>
            <label className="block font-mono text-[11px] text-muted uppercase tracking-widest">
              Name (optional — auto-filled when blank)
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Obsidian"
                className="mt-1 w-full rounded bg-raised border border-edge px-3 py-1.5 text-sm text-primary placeholder:text-dim focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </label>
            {error && <p className="font-mono text-xs text-danger">{error}</p>}
            <button
              onClick={fetchPreview}
              disabled={stage === "fetching" || !url.trim()}
              className="rounded bg-accent px-4 py-1.5 font-mono text-xs font-medium tracking-wide text-black hover:bg-accent-bright disabled:opacity-30"
            >
              {stage === "fetching" ? "Fetching…" : "Fetch"}
            </button>
          </div>
        ) : (
          <PreviewForm
            preview={preview!}
            onChange={setPreview}
            onSave={save}
            onBack={() => setStage("idle")}
            saving={stage === "saving"}
            error={error}
          />
        )}
      </div>
    </div>
  );
}

function PreviewForm({
  preview,
  onChange,
  onSave,
  onBack,
  saving,
  error,
}: {
  preview: EnrichedRecord;
  onChange: (p: EnrichedRecord) => void;
  onSave: () => void;
  onBack: () => void;
  saving: boolean;
  error: string;
}) {
  function update<K extends keyof EnrichedRecord>(key: K, value: EnrichedRecord[K]) {
    onChange({ ...preview, [key]: value });
  }
  return (
    <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
      <Field label="Name">
        <input
          value={preview.name}
          onChange={(e) => update("name", e.target.value)}
          className="w-full rounded bg-raised border border-edge px-3 py-1.5 text-sm"
        />
      </Field>
      <Field label="URL">
        <input
          value={preview.url}
          onChange={(e) => update("url", e.target.value)}
          className="w-full rounded bg-raised border border-edge px-3 py-1.5 text-sm"
        />
      </Field>
      <Field label="Category">
        <select
          value={preview.category}
          onChange={(e) => update("category", e.target.value as Rec["category"])}
          className="w-full rounded bg-raised border border-edge px-2 py-1.5 text-sm"
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </Field>
      <Field label="Description">
        <textarea
          value={preview.description}
          onChange={(e) => update("description", e.target.value)}
          rows={3}
          className="w-full rounded bg-raised border border-edge px-3 py-1.5 text-sm resize-y"
        />
      </Field>
      <Field label="Efficiency Gain">
        <textarea
          value={preview.efficiency_gain}
          onChange={(e) => update("efficiency_gain", e.target.value)}
          rows={2}
          className="w-full rounded bg-raised border border-edge px-3 py-1.5 text-sm resize-y"
        />
      </Field>
      <Field label="Use-cases (comma-separated)">
        <input
          value={preview.use_cases.join(", ")}
          onChange={(e) =>
            update(
              "use_cases",
              e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
          className="w-full rounded bg-raised border border-edge px-3 py-1.5 text-sm"
        />
      </Field>
      {preview.free === false && (
        <p className="rounded border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 font-mono text-[11px] text-yellow-200">
          ⚠ The extractor thinks this tool may not be fully free.
          {preview.free_check_reason ? ` Reason: "${preview.free_check_reason}"` : ""}
        </p>
      )}
      {error && <p className="font-mono text-xs text-danger">{error}</p>}
      <div className="flex gap-2 pt-2 border-t border-edge">
        <button
          onClick={onBack}
          disabled={saving}
          className="rounded border border-edge px-3 py-1.5 font-mono text-xs text-muted hover:text-primary disabled:opacity-30"
        >
          Back
        </button>
        <button
          onClick={onSave}
          disabled={saving}
          className="rounded bg-accent px-4 py-1.5 font-mono text-xs font-medium tracking-wide text-black hover:bg-accent-bright disabled:opacity-30"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block font-mono text-[11px] text-muted uppercase tracking-widest">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
```

- [ ] **Step 2: Wire the button into `App.tsx`**

Open `app/web/App.tsx`. At the top imports, add:

```tsx
import { useState } from "react"; // (may already be there)
import { AddToolModal } from "./AddToolModal";
```

Inside the component function add:

```tsx
const [addOpen, setAddOpen] = useState(false);
```

Then in the controls row (after the refresh button), add:

```tsx
<button
  onClick={() => setAddOpen(true)}
  className="rounded border border-edge px-3 py-1.5 font-mono text-xs font-medium tracking-wide text-primary hover:border-accent hover:text-accent transition-colors"
>
  + Add Tool
</button>
```

At the very end of the JSX (just before the closing `</div>` of the page), add:

```tsx
<AddToolModal
  open={addOpen}
  onClose={() => setAddOpen(false)}
  onAdded={load}
/>
```

(`load` is the existing function that fetches `/api/records` — confirm it's in scope; if not, name it consistently with the existing reload function.)

- [ ] **Step 3: Build + typecheck**

```bash
cd /home/jprentl/projects/claude-ai-tool-report/app
npx tsc --noEmit -p tsconfig.json 2>&1 | head -20
```

Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add app/web/AddToolModal.tsx app/web/App.tsx
git commit -m "feat(web): AddToolModal + toolbar button"
```

---

### Task 11: DetailPanel — Edit + Delete for curated records

**Files:**
- Modify: `app/web/DetailPanel.tsx`

**Interfaces:**
- Consumes: `api.updateTool`, `api.deleteTool`, `Rec.curated`. Reuses `AddToolModal` in "edit mode" by pre-filling its preview state.

For simplicity, the Edit-flow is: clicking Edit re-opens AddToolModal **with the preview already set to the current record** (no fetch step). Delete is a confirm + DELETE.

- [ ] **Step 1: Edit `DetailPanel.tsx`**

Open `app/web/DetailPanel.tsx`. Add imports:

```tsx
import { useState } from "react";
import { api, ApiError } from "./api";
```

Add this state inside the component:

```tsx
const [busy, setBusy] = useState(false);
const [err, setErr] = useState("");
```

Below the existing `Flag` button, add:

```tsx
{record.curated && (
  <div className="mt-2 flex gap-2">
    <button
      onClick={async () => {
        if (!confirm(`Delete '${record.name}' from your curated list?`)) return;
        setBusy(true);
        setErr("");
        try {
          await api.deleteTool(record.id);
          onClose();
          location.reload(); // simplest reload of the table
        } catch (e) {
          setErr(e instanceof Error ? e.message : "delete failed");
        } finally {
          setBusy(false);
        }
      }}
      disabled={busy}
      className="rounded border border-edge px-3 py-1 font-mono text-[11px] text-muted hover:border-danger hover:text-danger disabled:opacity-30"
    >
      Delete
    </button>
  </div>
)}
{err && <p className="mt-1 font-mono text-[11px] text-danger">{err}</p>}
```

For the **Edit** path we keep it minimal in V1: the user deletes and re-adds. Edit-in-place is a follow-up; the PATCH endpoint is in place so it's purely a UI add later. Document this in the README (Task 13).

- [ ] **Step 2: Typecheck**

```bash
cd /home/jprentl/projects/claude-ai-tool-report/app
npx tsc --noEmit -p tsconfig.json 2>&1 | head -10
```

Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add app/web/DetailPanel.tsx
git commit -m "feat(web): DetailPanel delete button for curated records"
```

---

### Task 12: Container smoke

**Files:** none modified.

- [ ] **Step 1: Rebuild + start**

```bash
cd /home/jprentl/projects/claude-ai-tool-report
./run.sh stop
./run.sh --build
```

Expected: build succeeds. Container starts. Boot log shows `[boot] embeddings backfill: …`.

- [ ] **Step 2: Wait for ready**

```bash
for i in $(seq 1 60); do
  sleep 5
  if curl -sf http://localhost:8788/api/health >/dev/null 2>&1; then echo "ready"; break; fi
done
```

- [ ] **Step 3: API smoke — enrich then add**

```bash
echo '=== enrich preview (no save)'
curl -sS -X POST http://localhost:8788/api/seeds/enrich \
  -H 'content-type: application/json' \
  -d '{"url":"https://github.com/anthropics/skills"}' | python3 -m json.tool | head -15

echo
echo '=== add a seed'
curl -sS -X POST http://localhost:8788/api/seeds \
  -H 'content-type: application/json' \
  -d '{"name":"smoke-test/x","url":"https://github.com/smoke-test/x","category":"plugin-skill"}' \
  -w '\nHTTP %{http_code}\n'

echo
echo '=== records includes the new seed'
curl -sS http://localhost:8788/api/records | python3 -c '
import json, sys
d = json.load(sys.stdin)
hit = [r for r in d["records"] if r["name"] == "smoke-test/x"]
print("found:", len(hit) == 1, "curated:", hit[0]["curated"] if hit else "—")
'

echo
echo '=== delete'
curl -sS -X DELETE http://localhost:8788/api/seeds/smoke-test%2Fx -w '\nHTTP %{http_code}\n'

echo
echo '=== records no longer has it'
curl -sS http://localhost:8788/api/records | python3 -c '
import json, sys
d = json.load(sys.stdin)
print("still there?", any(r["name"] == "smoke-test/x" for r in d["records"]))
'
```

Expected: enrich returns 200 with `name`, `url`, `category`, etc. POST returns 201. records includes the seed with `curated: true`. DELETE returns 200. records no longer contains it.

- [ ] **Step 4: Manual UI smoke**

Open `http://localhost:8788`. Click **+ Add Tool**. Paste a real homepage URL (e.g. `https://obsidian.md`). Click **Fetch**. Verify the modal shows the LLM-extracted fields. Edit something, click **Save**. Verify the table shows the entry with a ★ before the icon. Click the row → side-panel shows a Delete button. Delete → entry disappears.

- [ ] **Step 5: No commit — operational verification only**

---

### Task 13: README + SKILL.md update + push

**Files:**
- Modify: `README.md`
- Modify: `.claude/skills/efficiency-research/SKILL.md`

**Interfaces:** none.

- [ ] **Step 1: Update `README.md`**

Find the "Research pipeline" section. Add a new sibling section after it titled **"Curating tools by hand"**:

```md
## Curating tools by hand

Some tools the research crawler reliably misses (homepage-only apps,
niche-but-high-star single-skill repos, anything post-cutoff that
isn't yet indexed by search). For those, the app has an in-UI
**+ Add Tool** button:

1. Paste the tool's URL (GitHub repo URL or homepage), optionally a name.
2. Click **Fetch**. The backend hits the GitHub REST API for github
   URLs, or fetches the homepage + runs an LLM extraction otherwise.
3. Edit the auto-filled fields, click **Save**.
4. The record appears immediately, tagged ⭐ in the Name column.

Curated records survive every workflow re-run — they live in
`app/db/seeds.json` (db volume, not in git). Open the side-panel of
a curated record to delete it. Editing is currently delete + re-add.

The slug-collision rule: if the workflow later discovers a tool you
already curated, the two records are merged into one row that shows
your curated fields with the GitHub-derived stars/version/contributors
on top. The ⭐ badge stays.
```

In the "Research pipeline" section, remove the `report:seed` line from the bullet list of npm scripts (the script was deleted in Task 1):

```diff
- npm run report:seed     # NEW — merges seeds.json
```

- [ ] **Step 2: Update `SKILL.md`**

Open `.claude/skills/efficiency-research/SKILL.md`. The skill is about
the research pipeline; the seeds feature is orthogonal. Add a small
note at the very end:

```md
## Note on user-curated entries

The app's UI has its own "+ Add Tool" mechanism for entries the
crawler misses. Those records live in `app/db/seeds.json` and are
merged in-memory by the backend on every API request. They do not
appear in `data/raw-records.json` — the workflow's view of the world
is unchanged. See `docs/superpowers/specs/2026-06-30-user-curated-seeds-design.md`
for the design.
```

- [ ] **Step 3: Commit + push**

```bash
git add README.md .claude/skills/efficiency-research/SKILL.md
git commit -m "docs: + Add Tool feature in README + SKILL.md"
git push origin main
```

Expected: push succeeds. The new feature is live on the remote and documented.

---

## Self-Review

**Spec coverage:**

| Spec section | Task |
|---|---|
| Migration (delete old seeds.json + merge-seeds.mjs + report:seed) | Task 1 |
| `app/server/seeds.mjs` storage layer | Task 2 |
| `loadReport(dataDir, dbDir)` in-memory merge | Task 3 |
| `app/server/enrich.mjs` auto-fill | Task 4 |
| `indexRecord()` single-record indexer | Task 5 |
| API routes: enrich + POST + PATCH + DELETE | Task 6 |
| Boot wiring of enrich + indexer | Task 7 |
| Frontend types + api helpers | Task 8 |
| ⭐ curated badge | Task 9 |
| AddToolModal + toolbar button | Task 10 |
| DetailPanel delete (edit deferred to follow-up) | Task 11 |
| Container smoke | Task 12 |
| README + SKILL.md | Task 13 |

The spec mentions an "Edit" affordance in the DetailPanel. Task 11 documents it as deferred (delete + re-add for V1) and a follow-up note in README. The PATCH endpoint is in place (Task 6), so a future task can wire the modal in edit-mode without backend changes.

**Placeholder scan:** no TBDs, every code-step has a full code block, every command has an expected output, no "similar to Task N" pointers.

**Type consistency:**

- `Rec.curated: boolean` defined in Task 8, used in Task 9 (columns) and Task 11 (DetailPanel).
- `EnrichedRecord` shape defined in Task 8, returned by `/api/seeds/enrich` in Task 6, consumed by AddToolModal in Task 10.
- `slugOf` formula identical across Tasks 2, 4 (`enrich.mjs` uses URL parsing but emits the same string), 5 (backfill already uses the matching formula), 6 (`app.mjs` imports from `seeds.mjs`). The risk of drift is addressed in the spec's Risk section.
- `ApiError` defined in Task 8, thrown by `jsonFetch`, caught in Task 10 (modal).

No gaps.
