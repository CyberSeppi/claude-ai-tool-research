// Recover data/raw-records.json from a workflow's journal.jsonl when
// the research-pipeline's write-raw-records sub-agent stalls.
//
// Usage:
//   npm run report:recover -- <workflow-id-or-path>
//
// `workflow-id-or-path` may be:
//   - a short workflow id like "wbe68h55u" (we resolve the journal
//     via ~/.claude/projects/<project-slug>/subagents/workflows/wf_*/),
//   - a full session subdir + workflow path,
//   - a direct path to a journal.jsonl file.
//
// The script reads every `result` event with a `records` array, treats
// agents with started-index >= 16 as the verify wave (post-verification,
// authoritative), dedupes by owner/repo slug, sorts by stars desc, and
// overwrites data/raw-records.json.
//
// Survives the same input data the failed workflow already produced —
// the discover/verify work is preserved in the journal even when the
// downstream write-agent stalled.
import { readFileSync, writeFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DISCOVER_BOUNDARY = 16; // started-index <= 16 = discover wave; > = verify

function fail(msg) {
  console.error(`[recover] ${msg}`);
  process.exit(1);
}

function locateJournal(arg) {
  // Direct path
  if (arg && arg.endsWith(".jsonl") && existsSync(arg)) return arg;
  if (arg && existsSync(arg) && statSync(arg).isDirectory()) {
    const j = join(arg, "journal.jsonl");
    if (existsSync(j)) return j;
  }
  // Short workflow id — find under ~/.claude/projects/*/subagents/workflows/wf_*/journal.jsonl
  // Workflow ids look like "wbe68h55u" (task id) but the workflow dir is "wf_<random>".
  // We can't map task id → wf_ dir directly, so search by mtime of every journal.jsonl
  // and pick the most recent match.
  const projectsDir = join(homedir(), ".claude", "projects");
  if (!existsSync(projectsDir)) fail(`no ~/.claude/projects dir found`);

  // The journal lives at:
  //   ~/.claude/projects/<project>/<session-uuid>/subagents/workflows/<wf_id>/journal.jsonl
  // We walk the full tree because the layout has changed across Claude
  // Code versions and `find` was easier than guessing depths.
  const candidates = [];
  const walk = (dir, depth) => {
    if (depth > 6) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isFile() && e.name === "journal.jsonl") {
        // The wf_<id> dir is the immediate parent.
        const wf = dir.split("/").pop();
        try {
          candidates.push({ path: full, mtime: statSync(full).mtimeMs, wf });
        } catch {}
      } else if (e.isDirectory()) {
        walk(full, depth + 1);
      }
    }
  };
  walk(projectsDir, 0);
  if (!candidates.length) fail("no journal.jsonl files found under ~/.claude/projects");
  // If arg given AND matches part of a wf_ dir, prefer that. Otherwise
  // pick the most-recently-modified journal — that's almost always the
  // one the user means after a workflow just stalled.
  const matched = arg ? candidates.filter((c) => c.wf.includes(arg) || c.path.includes(arg)) : [];
  const pool = matched.length ? matched : candidates;
  pool.sort((a, b) => b.mtime - a.mtime);
  if (matched.length) {
    console.error(`[recover] matched '${arg}' → ${pool[0].path}`);
  } else if (arg) {
    console.error(`[recover] no exact match for '${arg}', falling back to most-recent journal`);
    console.error(`[recover]   → ${pool[0].path}`);
  } else {
    console.error(`[recover] auto-selected most-recent journal:`);
    console.error(`[recover]   → ${pool[0].path}`);
  }
  return pool[0].path;
}

function loadAgents(journalPath) {
  const agents = new Map();
  const text = readFileSync(journalPath, "utf8");
  let lineNo = 0;
  for (const raw of text.split("\n")) {
    lineNo++;
    const line = raw.trim();
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    const id = o.agentId;
    if (!id) continue;
    if (o.type === "started") {
      const e = agents.get(id) ?? {};
      e.started = lineNo;
      agents.set(id, e);
    } else if (o.type === "result") {
      const recs = o.result?.records;
      if (Array.isArray(recs)) {
        const e = agents.get(id) ?? {};
        e.result = lineNo;
        e.records = recs;
        agents.set(id, e);
      }
    }
  }
  return agents;
}

function slugOf(rec) {
  const u = String(rec.url ?? "").toLowerCase();
  const m = u.match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (m) return `${m[1]}/${m[2].replace(/\.git$/, "")}`;
  // Non-github (companion-app) — use the canonical name as the key,
  // lower-cased so casing doesn't fork the dedup.
  const n = String(rec.name ?? "").toLowerCase().trim();
  return n || null;
}

function isVerifyAgent(meta, boundary) {
  // Verify agents start AFTER all discover agents, which run in parallel
  // first. The journal records the start-index, so verify is the second
  // wave: started > <number of discover agents>.
  return typeof meta.started === "number" && meta.started > boundary;
}

const arg = process.argv[2];
const journalPath = locateJournal(arg);
console.error(`[recover] reading ${journalPath}`);

const agents = loadAgents(journalPath);
const withResults = [...agents.values()].filter((a) => Array.isArray(a.records));
console.error(`[recover] agents with result records: ${withResults.length}`);

// Decide boundary dynamically: the discover wave is the FIRST N parallel
// agents, where N matches the number of topics in research-topics.yaml
// (typically 15-17). We auto-detect by looking at the gap in started
// indices: discover agents have contiguous low indices, verify agents
// start much later.
const startedIdx = withResults
  .map((a) => a.started)
  .filter((n) => Number.isFinite(n))
  .sort((a, b) => a - b);

// Auto-detect boundary: pick the largest gap in started-index ordering.
// All agents started in the same wave have similar start indices; verify
// agents come after a measurable gap.
let boundary = DISCOVER_BOUNDARY;
if (startedIdx.length >= 2) {
  let maxGap = 0;
  let gapAt = startedIdx[0];
  for (let i = 1; i < startedIdx.length; i++) {
    const gap = startedIdx[i] - startedIdx[i - 1];
    if (gap > maxGap) {
      maxGap = gap;
      gapAt = startedIdx[i - 1];
    }
  }
  if (maxGap > 5) {
    boundary = gapAt;
    console.error(`[recover] auto-detected discover/verify boundary at started-index ${boundary} (gap ${maxGap})`);
  } else {
    console.error(`[recover] no clear discover/verify gap; using default boundary ${DISCOVER_BOUNDARY}`);
  }
}

const verifyAgents = withResults.filter((a) => isVerifyAgent(a, boundary));
const discoverAgents = withResults.filter((a) => !isVerifyAgent(a, boundary));
console.error(`[recover] discover wave: ${discoverAgents.length} agents`);
console.error(`[recover] verify wave:   ${verifyAgents.length} agents`);

// If verify agents exist, prefer them (post-verification, drops 404s,
// fixes star counts). Otherwise fall back to discover wave.
const source = verifyAgents.length ? verifyAgents : discoverAgents;
const which = verifyAgents.length ? "verify" : "discover";
console.error(`[recover] using ${which}-wave records as the authoritative set`);

const raw = source.flatMap((a) => a.records);
console.error(`[recover] raw records (pre-dedup): ${raw.length}`);

// Dedup by slug. Keep first occurrence. Normalise github-record names
// to the canonical owner/repo slug.
const seen = new Map();
for (const r of raw) {
  const k = slugOf(r);
  if (!k) continue;
  if (seen.has(k)) continue;
  const copy = { ...r };
  if (String(r.url ?? "").toLowerCase().includes("github.com")) {
    copy.name = k;
  }
  seen.set(k, copy);
}
const deduped = [...seen.values()];
deduped.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));

// Per-category tally for the operator
const cats = new Map();
for (const r of deduped) {
  cats.set(r.category, (cats.get(r.category) ?? 0) + 1);
}

// Write
const out = "data/raw-records.json";
writeFileSync(out, JSON.stringify(deduped, null, 2) + "\n");
console.error(`[recover] wrote ${deduped.length} records → ${out}`);
console.error(`[recover] by category:`);
for (const [c, n] of [...cats.entries()].sort((a, b) => b[1] - a[1])) {
  console.error(`            ${String(c).padEnd(15)} ${n}`);
}
console.error(`[recover] next: npm run report:augment && npm run report:build`);
