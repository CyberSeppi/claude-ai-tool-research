# Efficiency-Research Skill Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a project-level Claude skill that researches the best GitHub repos for boosting Claude Code efficiency, marks which are already installed locally, and emits `data/report.json` + `data/report.md`.

**Architecture:** The skill = LLM-driven research (instructions in `SKILL.md`) + two deterministic Node helper scripts. `scan-installed.mjs` enumerates locally-installed skills/plugins/MCP servers. `build-report.mjs` merges LLM-produced raw records with the scan, dedupes, validates, and writes the JSON + Markdown report. The deterministic scripts carry the tests; `SKILL.md` orchestrates the run.

**Tech Stack:** Node 20+ ESM (`.mjs`), built-in `node:test` + `node:assert` (no new dependencies), built-in `node:fs`/`node:path`/`node:os`.

## Global Constraints

- Node 20+ runtime; all scripts are ESM `.mjs`. (verbatim: project `package.json` has `"type": "module"`)
- No new npm dependencies — tests use built-in `node:test`; scripts use only `node:` builtins.
- No reliance on `ANTHROPIC_API_KEY` anywhere (subscription path only).
- `category` is an enum: exactly one of `plugin-skill | mcp-server | token-tool`.
- Record `id` = canonical slug: from a GitHub URL take `owner/repo`, else the name; lowercase; non-alphanumerics → `-`; trim leading/trailing `-`.
- `report.json` must conform to the schema in `docs/superpowers/specs/2026-06-29-skill-research-and-app-design.md` (validated by `validateReport`).
- Star counts are time-sensitive — every report stamps `generated_at` and every record stamps `last_researched`.

---

### Task 1: Local install scanner (`scan-installed.mjs`)

**Files:**
- Create: `.claude/skills/efficiency-research/scripts/scan-installed.mjs`
- Test: `.claude/skills/efficiency-research/scripts/scan-installed.test.mjs`
- Create (fixtures): `.claude/skills/efficiency-research/scripts/__fixtures__/home/.claude/skills/my-skill/SKILL.md`
- Create (fixtures): `.claude/skills/efficiency-research/scripts/__fixtures__/home/.claude/plugins/cache/acme/cool-plugin/.claude-plugin/plugin.json`
- Create (fixtures): `.claude/skills/efficiency-research/scripts/__fixtures__/home/.claude/plugins/cache/acme/cool-plugin/skills/bundled-skill/SKILL.md`
- Create (fixtures): `.claude/skills/efficiency-research/scripts/__fixtures__/home/.claude.json`

**Interfaces:**
- Produces:
  - `slugOf(url: string): string|null` — `https://github.com/owner/repo` → `"owner/repo"` (lowercased, `.git` stripped), else `null`.
  - `repoName(urlOrName: string): string` — last path segment of slug or name, lowercased.
  - `scanInstalled(opts?: {home?: string, cwd?: string}): Promise<{skills:{name,path}[], plugins:{name,path,marketplace}[], mcpServers:{name,source}[], installedSlugs: string[], installedNames: string[]}>`

- [ ] **Step 1: Create the fixture files**

`__fixtures__/home/.claude/skills/my-skill/SKILL.md`:
```markdown
---
name: my-skill
description: fixture skill
---
fixture
```

`__fixtures__/home/.claude/plugins/cache/acme/cool-plugin/.claude-plugin/plugin.json`:
```json
{ "name": "cool-plugin", "source": "https://github.com/acme/cool-plugin" }
```

`__fixtures__/home/.claude/plugins/cache/acme/cool-plugin/skills/bundled-skill/SKILL.md`:
```markdown
---
name: bundled-skill
description: fixture bundled skill
---
fixture
```

`__fixtures__/home/.claude.json`:
```json
{ "mcpServers": { "context7": { "command": "npx", "args": ["-y", "@upstash/context7-mcp"], "url": "https://github.com/upstash/context7" } } }
```

- [ ] **Step 2: Write the failing test**

`.claude/skills/efficiency-research/scripts/scan-installed.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scanInstalled, slugOf, repoName } from "./scan-installed.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const home = join(here, "__fixtures__", "home");

test("slugOf parses github urls", () => {
  assert.equal(slugOf("https://github.com/Upstash/Context7"), "upstash/context7");
  assert.equal(slugOf("git@github.com:acme/cool-plugin.git"), "acme/cool-plugin");
  assert.equal(slugOf("not a url"), null);
});

test("repoName falls back to last segment", () => {
  assert.equal(repoName("https://github.com/anthropics/skills"), "skills");
  assert.equal(repoName("context7"), "context7");
});

test("scanInstalled finds skills, plugins, mcp, slugs, names", async () => {
  const r = await scanInstalled({ home, cwd: join(here, "__fixtures__", "nocwd") });
  const skillNames = r.skills.map((s) => s.name).sort();
  assert.deepEqual(skillNames, ["bundled-skill", "my-skill"]);
  assert.deepEqual(r.plugins.map((p) => p.name), ["cool-plugin"]);
  assert.equal(r.plugins[0].marketplace, "acme");
  assert.deepEqual(r.mcpServers.map((m) => m.name), ["context7"]);
  assert.ok(r.installedSlugs.includes("acme/cool-plugin"));
  assert.ok(r.installedSlugs.includes("upstash/context7"));
  for (const n of ["my-skill", "bundled-skill", "cool-plugin", "context7"]) {
    assert.ok(r.installedNames.includes(n), `missing name ${n}`);
  }
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test .claude/skills/efficiency-research/scripts/scan-installed.test.mjs`
Expected: FAIL — `Cannot find module './scan-installed.mjs'`.

- [ ] **Step 4: Write the implementation**

`.claude/skills/efficiency-research/scripts/scan-installed.mjs`:
```js
import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const norm = (s) => String(s).toLowerCase().replace(/\.git$/, "").trim();

export function slugOf(url) {
  const m = norm(url).match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/);
  return m ? `${m[1]}/${m[2].replace(/\.git$/, "")}` : null;
}

export function repoName(urlOrName) {
  const slug = slugOf(urlOrName);
  if (slug) return slug.split("/")[1];
  return norm(urlOrName).split("/").pop();
}

async function listDirs(p) {
  if (!existsSync(p)) return [];
  const ents = await readdir(p, { withFileTypes: true });
  return ents.filter((e) => e.isDirectory()).map((e) => e.name);
}

function slugsFromText(text) {
  const out = new Set();
  const re = /github\.com[/:]([\w.-]+)\/([\w.-]+)/gi;
  let m;
  while ((m = re.exec(text))) out.add(norm(`${m[1]}/${m[2].replace(/\.git$/, "")}`));
  return [...out];
}

async function addSlugsFromFile(path, set) {
  if (!existsSync(path)) return;
  try {
    slugsFromText(await readFile(path, "utf8")).forEach((s) => set.add(s));
  } catch {}
}

export async function scanInstalled(opts = {}) {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const skills = [];
  const plugins = [];
  const mcpServers = [];
  const installedSlugs = new Set();
  const installedNames = new Set();

  for (const root of [join(home, ".claude", "skills"), join(cwd, ".claude", "skills")]) {
    for (const name of await listDirs(root)) {
      skills.push({ name, path: join(root, name) });
      installedNames.add(norm(name));
    }
  }

  const cache = join(home, ".claude", "plugins", "cache");
  for (const market of await listDirs(cache)) {
    for (const plugin of await listDirs(join(cache, market))) {
      const path = join(cache, market, plugin);
      plugins.push({ name: plugin, path, marketplace: market });
      installedNames.add(norm(plugin));
      for (const sk of await listDirs(join(path, "skills"))) {
        skills.push({ name: sk, path: join(path, "skills", sk) });
        installedNames.add(norm(sk));
      }
      for (const mf of ["plugin.json", join(".claude-plugin", "plugin.json"), "package.json"]) {
        await addSlugsFromFile(join(path, mf), installedSlugs);
      }
    }
  }

  for (const f of [join(home, ".claude.json"), join(cwd, ".mcp.json"), join(cwd, ".claude", "settings.json")]) {
    if (!existsSync(f)) continue;
    await addSlugsFromFile(f, installedSlugs);
    try {
      const j = JSON.parse(await readFile(f, "utf8"));
      const servers = j.mcpServers ?? j.mcp?.servers ?? {};
      for (const name of Object.keys(servers)) {
        mcpServers.push({ name, source: f });
        installedNames.add(norm(name));
      }
    } catch {}
  }

  return {
    skills,
    plugins,
    mcpServers,
    installedSlugs: [...installedSlugs],
    installedNames: [...installedNames],
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test .claude/skills/efficiency-research/scripts/scan-installed.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/efficiency-research/scripts/scan-installed.mjs .claude/skills/efficiency-research/scripts/scan-installed.test.mjs .claude/skills/efficiency-research/scripts/__fixtures__
git commit -m "feat(skill): local install scanner for efficiency-research"
```

---

### Task 2: Report builder pure logic (`build-report.mjs`)

**Files:**
- Create: `.claude/skills/efficiency-research/scripts/build-report.mjs`
- Test: `.claude/skills/efficiency-research/scripts/build-report.test.mjs`

**Interfaces:**
- Consumes: `slugOf`, `repoName` from `./scan-installed.mjs`; the scan object shape from Task 1.
- Produces:
  - `idOf(record): string` — canonical slug id (Global Constraints rule).
  - `matchInstalled(record, scan): {installed: boolean, installed_path: string|null, installed_via: string|null}`
  - `buildReport(rawRecords, scan, {generatedAt, date, query}): {generated_at, query, records[]}`
  - `validateReport(report): true` — throws `Error` on a malformed report.
  - `renderMarkdown(report): string`

- [ ] **Step 1: Write the failing test**

`.claude/skills/efficiency-research/scripts/build-report.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { idOf, matchInstalled, buildReport, validateReport, renderMarkdown } from "./build-report.mjs";

const scan = {
  skills: [{ name: "my-skill", path: "/h/.claude/skills/my-skill" }],
  plugins: [{ name: "cool-plugin", path: "/h/cache/acme/cool-plugin", marketplace: "acme" }],
  mcpServers: [{ name: "context7", source: "/h/.claude.json" }],
  installedSlugs: ["acme/cool-plugin", "upstash/context7"],
  installedNames: ["my-skill", "cool-plugin", "context7"],
};

const raw = [
  { name: "acme/cool-plugin", url: "https://github.com/acme/cool-plugin", category: "plugin-skill", stars: 100, stars_display: "100", description: "d", efficiency_gain: "e", sources: ["https://github.com/acme/cool-plugin"], confidence: "high" },
  { name: "upstash/context7", url: "https://github.com/upstash/context7", category: "mcp-server", stars: 58300, stars_display: "~58k", description: "docs", efficiency_gain: "current docs", sources: ["https://github.com/upstash/context7"], confidence: "high" },
  { name: "foo/bar", url: "https://github.com/foo/bar", category: "token-tool", stars: 5, stars_display: "5", description: "x", efficiency_gain: "y", sources: [], confidence: "low" },
  { name: "acme/cool-plugin", url: "https://github.com/acme/cool-plugin", category: "plugin-skill", description: "dup", efficiency_gain: "", sources: [] },
];

test("idOf builds canonical slug", () => {
  assert.equal(idOf({ url: "https://github.com/Anthropics/Skills" }), "anthropics-skills");
  assert.equal(idOf({ name: "Token Optimizer!" }), "token-optimizer");
});

test("matchInstalled detects by name and by slug, and misses unknown", () => {
  const a = matchInstalled(raw[0], scan);
  assert.equal(a.installed, true);
  assert.equal(a.installed_via, "plugin:acme");
  assert.equal(a.installed_path, "/h/cache/acme/cool-plugin");
  const b = matchInstalled(raw[1], scan);
  assert.equal(b.installed, true);
  assert.equal(b.installed_via, "mcp");
  const c = matchInstalled(raw[2], scan);
  assert.equal(c.installed, false);
  assert.equal(c.installed_path, null);
});

test("buildReport dedupes, merges install state, stamps dates", () => {
  const rep = buildReport(raw, scan, { generatedAt: "2026-06-29T00:00:00Z", date: "2026-06-29", query: "q" });
  assert.equal(rep.generated_at, "2026-06-29T00:00:00Z");
  assert.equal(rep.records.length, 3); // dup dropped
  const cool = rep.records.find((r) => r.id === "acme-cool-plugin");
  assert.equal(cool.installed, true);
  assert.equal(cool.last_researched, "2026-06-29");
  assert.equal(cool.confidence, "high");
});

test("buildReport rejects bad category", () => {
  assert.throws(() => buildReport([{ name: "x", url: "https://github.com/a/x", category: "nope" }], scan, { generatedAt: "t", date: "d" }), /category/);
});

test("validateReport throws on missing url", () => {
  const bad = { generated_at: "t", query: "q", records: [{ id: "a", name: "a", category: "token-tool" }] };
  assert.throws(() => validateReport(bad), /url/);
});

test("renderMarkdown groups by category with install marks", () => {
  const rep = buildReport(raw, scan, { generatedAt: "t", date: "2026-06-29", query: "q" });
  const md = renderMarkdown(rep);
  assert.match(md, /## MCP Servers/);
  assert.match(md, /upstash\/context7/);
  assert.match(md, /✓/); // installed marker present
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test .claude/skills/efficiency-research/scripts/build-report.test.mjs`
Expected: FAIL — `Cannot find module './build-report.mjs'`.

- [ ] **Step 3: Write the implementation**

`.claude/skills/efficiency-research/scripts/build-report.mjs`:
```js
import { slugOf, repoName } from "./scan-installed.mjs";

const norm = (s) => String(s).toLowerCase().replace(/\.git$/, "").trim();

const CATEGORIES = ["plugin-skill", "mcp-server", "token-tool"];
const CATEGORY_TITLES = {
  "plugin-skill": "Plugins & Skills",
  "mcp-server": "MCP Servers",
  "token-tool": "Token & Research Tools",
};

export function idOf(record) {
  const base = (record.url && slugOf(record.url)) || record.name || "";
  return norm(base).replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function matchInstalled(record, scan) {
  const name = repoName(record.url || record.name || "");
  const slug = slugOf(record.url || "");
  const byName = (arr) => arr.find((e) => norm(e.name) === name);
  const plugin = byName(scan.plugins);
  if (plugin) return { installed: true, installed_path: plugin.path, installed_via: `plugin:${plugin.marketplace}` };
  const skill = byName(scan.skills);
  if (skill) return { installed: true, installed_path: skill.path, installed_via: "skill" };
  const mcp = byName(scan.mcpServers);
  if (mcp) return { installed: true, installed_path: mcp.source, installed_via: "mcp" };
  if (slug && scan.installedSlugs.includes(slug)) return { installed: true, installed_path: null, installed_via: "marketplace" };
  return { installed: false, installed_path: null, installed_via: null };
}

export function buildReport(rawRecords, scan, { generatedAt, date, query = "" }) {
  const seen = new Set();
  const records = [];
  for (const r of rawRecords) {
    if (!CATEGORIES.includes(r.category)) throw new Error(`bad category: ${r.category}`);
    const id = idOf(r);
    if (seen.has(id)) continue;
    seen.add(id);
    const inst = matchInstalled(r, scan);
    records.push({
      id,
      name: r.name,
      url: r.url,
      category: r.category,
      stars: r.stars ?? null,
      stars_display: r.stars_display ?? null,
      description: r.description ?? "",
      efficiency_gain: r.efficiency_gain ?? "",
      installed: inst.installed,
      installed_path: inst.installed_path,
      installed_via: inst.installed_via,
      sources: r.sources ?? [],
      confidence: r.confidence ?? "medium",
      last_researched: date,
    });
  }
  return { generated_at: generatedAt, query, records };
}

export function validateReport(report) {
  if (!report || typeof report !== "object") throw new Error("report not an object");
  if (!report.generated_at) throw new Error("missing generated_at");
  if (!Array.isArray(report.records)) throw new Error("records not an array");
  for (const r of report.records) {
    for (const f of ["id", "name", "url", "category"]) {
      if (!r[f]) throw new Error(`record missing ${f}: ${JSON.stringify(r).slice(0, 80)}`);
    }
    if (!CATEGORIES.includes(r.category)) throw new Error(`bad category: ${r.category}`);
  }
  return true;
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push("# Claude Efficiency Repos — Research Report", "");
  lines.push(`> Generated: ${report.generated_at}. Star counts are time-sensitive snapshots.`, "");
  for (const cat of CATEGORIES) {
    const rows = report.records.filter((r) => r.category === cat);
    if (!rows.length) continue;
    lines.push(`## ${CATEGORY_TITLES[cat]}`, "");
    lines.push("| Repo | Stars | Installed | Description |", "|---|---|---|---|");
    for (const r of rows) {
      const mark = r.installed ? "✓" : "—";
      lines.push(`| [${r.name}](${r.url}) | ${r.stars_display ?? "?"} | ${mark} | ${r.description} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test .claude/skills/efficiency-research/scripts/build-report.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/efficiency-research/scripts/build-report.mjs .claude/skills/efficiency-research/scripts/build-report.test.mjs
git commit -m "feat(skill): report builder, install-matching, markdown render"
```

---

### Task 3: CLI runner + file writing (`run` in `build-report.mjs`)

**Files:**
- Modify: `.claude/skills/efficiency-research/scripts/build-report.mjs` (add `run` + CLI entry)
- Test: `.claude/skills/efficiency-research/scripts/run.test.mjs`
- Modify: `package.json` (add scripts)

**Interfaces:**
- Consumes: `scanInstalled`, `buildReport`, `validateReport`, `renderMarkdown`.
- Produces: `run(opts: {rawRecordsPath: string, outDir: string, home?: string, cwd?: string, now?: Date, query?: string}): Promise<{report, jsonPath, mdPath}>` — scans, builds, validates, writes `report.json` + `report.md` into `outDir`, returns paths.

- [ ] **Step 1: Write the failing test**

`.claude/skills/efficiency-research/scripts/run.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./build-report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const home = join(here, "__fixtures__", "home");

test("run scans, builds, writes valid report.json + report.md", async () => {
  const dir = await mkdtemp(join(tmpdir(), "effres-"));
  try {
    const rawPath = join(dir, "raw-records.json");
    await writeFile(rawPath, JSON.stringify([
      { name: "upstash/context7", url: "https://github.com/upstash/context7", category: "mcp-server", stars: 58300, stars_display: "~58k", description: "docs", efficiency_gain: "current docs", sources: [], confidence: "high" },
    ]));
    const out = join(dir, "data");
    await mkdir(out, { recursive: true });
    const res = await run({ rawRecordsPath: rawPath, outDir: out, home, cwd: join(here, "nocwd"), now: new Date("2026-06-29T00:00:00Z"), query: "q" });
    const json = JSON.parse(await readFile(res.jsonPath, "utf8"));
    assert.equal(json.records.length, 1);
    assert.equal(json.records[0].installed, true); // context7 in fixture .claude.json
    assert.equal(json.records[0].last_researched, "2026-06-29");
    const md = await readFile(res.mdPath, "utf8");
    assert.match(md, /upstash\/context7/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test .claude/skills/efficiency-research/scripts/run.test.mjs`
Expected: FAIL — `run` is not exported (`run is not a function`).

- [ ] **Step 3: Add `run` + CLI entry to `build-report.mjs`**

Append to `.claude/skills/efficiency-research/scripts/build-report.mjs`:
```js
import { readFile as _readFile, writeFile as _writeFile } from "node:fs/promises";
import { join as _join } from "node:path";
import { scanInstalled } from "./scan-installed.mjs";

export async function run({ rawRecordsPath, outDir, home, cwd, now = new Date(), query = "" }) {
  const raw = JSON.parse(await _readFile(rawRecordsPath, "utf8"));
  const scan = await scanInstalled({ home, cwd });
  const date = now.toISOString().slice(0, 10);
  const report = buildReport(raw, scan, { generatedAt: now.toISOString(), date, query });
  validateReport(report);
  const jsonPath = _join(outDir, "report.json");
  const mdPath = _join(outDir, "report.md");
  await _writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n");
  await _writeFile(mdPath, renderMarkdown(report) + "\n");
  return { report, jsonPath, mdPath };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const rawRecordsPath = process.argv[2] ?? "data/raw-records.json";
  const outDir = process.argv[3] ?? "data";
  run({ rawRecordsPath, outDir })
    .then((r) => console.log(`Wrote ${r.report.records.length} records -> ${r.jsonPath}, ${r.mdPath}`))
    .catch((err) => {
      console.error(err.message);
      process.exit(1);
    });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test .claude/skills/efficiency-research/scripts/run.test.mjs`
Expected: PASS (1 test).

- [ ] **Step 5: Add npm scripts**

In `package.json`, replace the `"scripts"` block with:
```json
  "scripts": {
    "ask": "tsx ask.ts",
    "test:skill": "node --test .claude/skills/efficiency-research/scripts/",
    "research:build": "node .claude/skills/efficiency-research/scripts/build-report.mjs"
  },
```

- [ ] **Step 6: Run the full skill test suite**

Run: `npm run test:skill`
Expected: PASS — all tests across the three `*.test.mjs` files (10 tests total).

- [ ] **Step 7: Commit**

```bash
git add .claude/skills/efficiency-research/scripts/build-report.mjs .claude/skills/efficiency-research/scripts/run.test.mjs package.json
git commit -m "feat(skill): CLI runner writes report.json + report.md"
```

---

### Task 4: `SKILL.md` orchestration + first real report

**Files:**
- Create: `.claude/skills/efficiency-research/SKILL.md`
- Create: `research-topics.yaml` (repo root — user-editable, human-readable, weighted list of what to research)
- Create: `data/raw-records.json` (seed, derived from `claude-efficiency-repos.md`)
- Create: `data/report.json`, `data/report.md` (generated)

**Interfaces:**
- Consumes: `run` CLI (`npm run research:build`) and the scan/build scripts from Tasks 1–3; `research-topics.yaml` (LLM-read, drives what gets researched).
- Produces: the `efficiency-research` skill, invocable from Claude Code; a real `data/report.json` the app round will import.

> **Note:** Use the `superpowers:writing-skills` skill to author `SKILL.md` (frontmatter, trigger description, structure).

- [ ] **Step 1: Author `SKILL.md`**

Create `.claude/skills/efficiency-research/SKILL.md` with this content:
````markdown
---
name: efficiency-research
description: Research the best GitHub repos for boosting Claude Code efficiency (plugins/skills, MCP servers, token/research tools), mark which are already installed locally, and write data/report.json + data/report.md. Use when the user wants to (re)run the Claude-efficiency repo research or refresh the report.
---

# Efficiency Research

Produce a fact-checked, install-aware report of the best GitHub repos that boost
Claude Code efficiency. Output: `data/report.json` (machine-readable) + `data/report.md`.

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
   `sources` (string[]), `confidence` (`high|medium|low`). Do NOT add install fields.

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
````

- [ ] **Step 2: Create `research-topics.yaml` (repo root)**

Create `research-topics.yaml` at the project root with this content:
```yaml
# research-topics.yaml — controls WHAT the efficiency-research skill researches.
# Edit freely. weight: 1 (minor) .. 5 (must-have) — higher weight = research deeper
# and rank/prioritise its hits more strongly in the report.
#
# category must be one of: plugin-skill | mcp-server | token-tool

topics:
  - topic: "Claude Code plugins, skill packs, subagent collections, plugin marketplaces"
    category: plugin-skill
    weight: 5

  - topic: "MCP servers for web search & research-source access (multi-engine, scraping, deep research)"
    category: mcp-server
    weight: 5

  - topic: "MCP servers for up-to-date / version-specific docs (reduce hallucinated APIs)"
    category: mcp-server
    weight: 4

  - topic: "MCP servers for dev-workflow automation (git/GitHub, CI, issues/PRs)"
    category: mcp-server
    weight: 3

  - topic: "Token-saving & context-compression tools (terser output, smaller context)"
    category: token-tool
    weight: 4

  - topic: "Skills / agents for brainstorming & ideation"
    category: plugin-skill
    weight: 3
```

- [ ] **Step 3: Create the seed `data/raw-records.json`**

Convert the existing `claude-efficiency-repos.md` into `data/raw-records.json` (a JSON array following the raw-record shape in Step 1). Include the 11 repos already researched (anthropics/skills, anthropics/claude-plugins-official, VoltAgent/awesome-claude-code-subagents, alirezarezvani/claude-skills, modelcontextprotocol/servers, upstash/context7, github/github-mcp-server, firecrawl/firecrawl-mcp-server, spences10/mcp-omnisearch, drona23/claude-token-efficient, alexgreensh/token-optimizer), with the verified star numbers and descriptions from that file.

- [ ] **Step 4: Generate the real report**

Run: `npm run research:build`
Expected: stdout `Wrote 11 records -> data/report.json, data/report.md`.

- [ ] **Step 5: Verify the generated report**

Write a tiny ESM check (avoids the top-level-await-in-`node -e` pitfall). Run:
```bash
node --input-type=module -e "import('./.claude/skills/efficiency-research/scripts/build-report.mjs').then(async (m)=>{const r=JSON.parse(await (await import('node:fs/promises')).readFile('./data/report.json','utf8'));m.validateReport(r);console.log('valid',r.records.length,'installed:',r.records.filter(x=>x.installed).length);}).catch((e)=>{console.error(e.message);process.exit(1);})"
```
Expected: prints `valid 11 installed: <n>` with no throw. (`<n>` ≥ 1 — at least entries that resolve to locally-installed skills/plugins, plus any MCP servers configured locally.)

- [ ] **Step 6: Commit**

```bash
git add .claude/skills/efficiency-research/SKILL.md research-topics.yaml data/raw-records.json data/report.json data/report.md
git commit -m "feat(skill): efficiency-research SKILL.md, weighted topics, first report"
```

---

## Self-Review

**Spec coverage:**
- Skill at `.claude/skills/efficiency-research/` → Tasks 1–4. ✓
- Web research with verification → SKILL.md Step 1. ✓
- System scan for installed items → Task 1 (`scanInstalled`). ✓
- Cross-reference / mark installed → Task 2 (`matchInstalled`). ✓
- `report.json` schema + `report.md` → Tasks 2–3 (`buildReport`/`validateReport`/`renderMarkdown`/`run`). ✓
- Robustness (tolerate missing dirs, dedupe, verify stars, stamp dates) → Task 1 `listDirs`/try-catch, Task 2 dedupe + dates, SKILL.md verify step. ✓
- `id` stable slug for app flag-keying → Task 2 `idOf` + Global Constraints. ✓
- Build order skill-first; app captured in spec only → this plan is Part 1 only. ✓

**Placeholder scan:** No TBD/TODO; every code step has complete code. Task 4 Step 2 (seed conversion) describes data transcription from a named existing file with the exact 11 repos listed — content-complete, not a placeholder.

**Type consistency:** `scanInstalled` return shape (skills/plugins/mcpServers/installedSlugs/installedNames) is consumed identically by `matchInstalled` and `run`. `slugOf`/`repoName` imported from `scan-installed.mjs` in `build-report.mjs`. `run` returns `{report, jsonPath, mdPath}` matching `run.test.mjs`. Consistent.
