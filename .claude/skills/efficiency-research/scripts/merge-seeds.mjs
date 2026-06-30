// merge-seeds.mjs
//
// Overlay manually curated records (data/seeds.json) onto the
// workflow-produced data/raw-records.json. Seeds REPLACE matching
// raw-records by slug, or APPEND when no match. After the merge,
// `blacklist` slugs are removed entirely. The result is re-sorted by
// stars descending — same convention as research-pipeline.js and
// recover-from-journal.mjs.
//
// Pipeline order (after a workflow finishes writing raw-records.json):
//   npm run report:seed
//   npm run report:augment   (fills null stars/version/contributors)
//   npm run report:build     (writes report.{json,md})
//
// Slug identity MUST match augment-github-meta.mjs:
//   extract github.com/owner/repo from (repo_url || url || name);
//   else lower(name). Changing the formula here without changing the
//   augment script will create phantom duplicates.
//
// stars / stars_display / version / contributors in seeds.json MUST be
// null. Augment is the authoritative source. A non-null seed value
// would silently override fresh GitHub data and become stale; the
// script warns when it sees one but still applies the merge.
//
// On a fresh checkout, both files may be absent. We treat missing
// inputs as empty arrays (notice, exit 0) so this script is safe to
// run unconditionally in CI / hooks / cold-start.
import { readFile, writeFile } from "node:fs/promises";

const SEEDS_PATH = "data/seeds.json";
const RAW_PATH = "data/raw-records.json";

const CATEGORIES = new Set(["plugin-skill", "mcp-server", "token-tool", "companion-app"]);

const AUGMENT_FIELDS = ["stars", "stars_display", "version", "contributors"];

function fail(msg, code = 1) {
  console.error(`[seed:merge] ERROR: ${msg}`);
  process.exit(code);
}

// Must match augment-github-meta.mjs slugOf().
function slugOf(rec) {
  const source = (rec.repo_url && String(rec.repo_url).trim()) || rec.url || rec.name || "";
  const m = String(source)
    .toLowerCase()
    .match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (m) return `${m[1]}/${m[2].replace(/\.git$/, "")}`;
  // Non-github (companion-app with homepage url) → lower(name)
  return String(rec.name ?? "").toLowerCase().trim() || null;
}

async function readJsonOrEmpty(path, defaultValue) {
  try {
    const txt = await readFile(path, "utf8");
    try {
      return JSON.parse(txt);
    } catch (parseErr) {
      fail(`parsing ${path}: ${parseErr.message}`);
    }
  } catch (err) {
    if (err.code === "ENOENT") {
      console.error(`[seed:merge] notice: ${path} not found; treating as empty`);
      return defaultValue;
    }
    fail(`reading ${path}: ${err.message}`);
  }
}

function validateSeed(seed, idx) {
  if (typeof seed !== "object" || seed === null) {
    fail(`seed[${idx}] is not an object`);
  }
  if (typeof seed.name !== "string" || !seed.name.trim()) {
    fail(`seed[${idx}] missing or empty 'name'`);
  }
  if (typeof seed.url !== "string" || !seed.url.trim()) {
    fail(`seed[${idx}] (name=${seed.name}) missing or empty 'url'`);
  }
  if (!CATEGORIES.has(seed.category)) {
    fail(
      `seed[${idx}] (name=${seed.name}) has invalid category '${seed.category}' ` +
        `(must be one of ${[...CATEGORIES].join(" | ")})`,
    );
  }
  for (const f of AUGMENT_FIELDS) {
    if (seed[f] !== null && seed[f] !== undefined) {
      console.error(
        `[seed:merge] WARNING: seed '${seed.name}' has non-null ${f}=${JSON.stringify(seed[f])} — ` +
          `this overrides augment data and may go stale. Set to null to let augment fill it.`,
      );
    }
  }
}

const seedsFile = await readJsonOrEmpty(SEEDS_PATH, { records: [], blacklist: [] });
const rawRecords = await readJsonOrEmpty(RAW_PATH, []);

if (!Array.isArray(rawRecords)) fail(`${RAW_PATH} is not a JSON array`);

const seeds = Array.isArray(seedsFile?.records) ? seedsFile.records : [];
const blacklist = Array.isArray(seedsFile?.blacklist) ? seedsFile.blacklist.map((s) => String(s).toLowerCase()) : [];

// Validate every seed before any merge work
seeds.forEach((s, i) => validateSeed(s, i));

// Detect duplicate slugs within seeds.json itself (hard fail — silent
// last-wins is the worst kind of data loss)
const seedSlugs = new Map();
for (let i = 0; i < seeds.length; i++) {
  const slug = slugOf(seeds[i]);
  if (!slug) fail(`seed[${i}] (name=${seeds[i].name}) — could not compute slug`);
  if (seedSlugs.has(slug)) {
    const prev = seedSlugs.get(slug);
    fail(
      `duplicate slug '${slug}' in seeds.json: ` +
        `entry #${prev} (name=${seeds[prev].name}) collides with ` +
        `entry #${i} (name=${seeds[i].name})`,
    );
  }
  seedSlugs.set(slug, i);
}

// Index raw-records by slug for replace lookup
const rawBySlug = new Map();
for (const rec of rawRecords) {
  const slug = slugOf(rec);
  if (slug) rawBySlug.set(slug, rec);
}

const merged = [];
const seenSlugs = new Set();
let replaced = 0;
let appended = 0;

// Pass 1: copy raw-records (but skip blacklisted, and skip ones a seed
// will replace — they're appended by pass 2 in the seed's position).
for (const rec of rawRecords) {
  const slug = slugOf(rec);
  if (!slug) continue;
  if (blacklist.includes(slug)) {
    console.error(`[seed:merge] blacklisted: removed '${slug}'`);
    continue;
  }
  if (seedSlugs.has(slug)) {
    // Will be replaced — skip here; the seed in pass 2 contributes.
    continue;
  }
  merged.push(rec);
  seenSlugs.add(slug);
}

// Pass 2: process seeds. REPLACE (if raw had it) or APPEND otherwise.
for (const seed of seeds) {
  const slug = slugOf(seed);
  if (blacklist.includes(slug)) {
    console.error(`[seed:merge] notice: seed '${slug}' is also on the blacklist — skipped`);
    continue;
  }
  const existing = rawBySlug.get(slug);
  if (existing) {
    // REPLACE: take all seed fields, but preserve augment-filled
    // values from raw when the seed left them null.
    const replacement = { ...existing, ...seed };
    for (const f of AUGMENT_FIELDS) {
      if ((seed[f] === null || seed[f] === undefined) && existing[f] != null) {
        replacement[f] = existing[f];
      }
    }
    // Compute what actually changed for the audit log
    const changed = [];
    for (const k of Object.keys(seed)) {
      if (JSON.stringify(seed[k]) !== JSON.stringify(existing[k])) changed.push(k);
    }
    merged.push(replacement);
    seenSlugs.add(slug);
    replaced++;
    console.error(
      `[seed:merge] replaced '${slug}' (fields changed: ${changed.join(", ") || "(none — seed identical)"})`,
    );
  } else {
    merged.push(seed);
    seenSlugs.add(slug);
    appended++;
    console.error(`[seed:merge] appended '${slug}'`);
  }
}

// Re-sort by stars desc (null last), matching pipeline + recovery convention
merged.sort((a, b) => (b.stars ?? 0) - (a.stars ?? 0));

await writeFile(RAW_PATH, JSON.stringify(merged, null, 2) + "\n");

console.error(
  `[seed:merge] wrote ${merged.length} records → ${RAW_PATH}` +
    ` (raw=${rawRecords.length}, seeds=${seeds.length}, replaced=${replaced}, appended=${appended},` +
    ` blacklisted=${rawRecords.length - merged.length + appended})`,
);
