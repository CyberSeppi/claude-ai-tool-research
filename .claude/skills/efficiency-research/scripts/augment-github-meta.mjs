// Augment data/raw-records.json with version (latest release tag) and
// contributors (exact count via Link-header pagination).
//
// Pure HTTP / no LLM. Run with:
//   GITHUB_TOKEN=ghp_... node .claude/skills/efficiency-research/scripts/augment-github-meta.mjs
//
// Reads data/raw-records.json, writes the same file back with two new
// fields per record. Records that already have non-null version /
// contributors are skipped unless --force is passed.
//
// Respects HTTPS_PROXY / NO_PROXY via undici.ProxyAgent.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

// undici lives in app/node_modules — the script is invoked from the
// repo root, so resolve the package URL by hand instead of relying on
// node's package resolver.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..", "..", "..");
const undiciEntry = pathToFileURL(resolve(repoRoot, "app/node_modules/undici/index.js"))
  .href;
const { ProxyAgent, setGlobalDispatcher } = await import(undiciEntry);

const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || "";
if (proxyUrl) {
  const noProxy = (process.env.NO_PROXY || process.env.no_proxy || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  setGlobalDispatcher(
    new ProxyAgent({ uri: proxyUrl, ...(noProxy.length ? { noProxy } : {}) }),
  );
}

const TOKEN = process.env.GITHUB_TOKEN;
if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

const force = process.argv.includes("--force");
const path = process.argv.find((a) => a.endsWith(".json")) ?? "data/raw-records.json";

const HEADERS = {
  "Authorization": `Bearer ${TOKEN}`,
  "Accept": "application/vnd.github+json",
  "User-Agent": "claude-ai-tool-research",
  "X-GitHub-Api-Version": "2022-11-28",
};

function slugOf(rec) {
  // Prefer the explicit repo_url; fall back to the homepage URL only
  // when it points at a github repo. Non-github tools (e.g. obsidian.md)
  // return null and are skipped — they keep stars/version/contributors
  // at null and the augment phase is a no-op for them.
  const source =
    (rec.repo_url && String(rec.repo_url).trim()) || rec.url || rec.name || "";
  const m = String(source)
    .toLowerCase()
    .match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (m) return `${m[1]}/${m[2].replace(/\.git$/, "")}`;
  return null;
}

// Format an integer star count as a short display string consistent
// with what the LLM discover phase produces:
//   <1000        → "850"
//   1000–9999    → "6.7k"
//   10000–       → "~58k"
function formatStars(n) {
  if (n == null) return null;
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `~${Math.round(n / 1000)}k`;
}

// Fetch stargazers_count + (incidentally) other repo metadata via
// /repos/{owner}/{repo}. Returns { stars, stars_display } or null on
// any failure. Star count drifts; we treat the augment pass as the
// authoritative source.
async function fetchStars(slug) {
  try {
    const r = await fetch(`https://api.github.com/repos/${slug}`, {
      headers: HEADERS,
    });
    if (!r.ok) return null;
    const j = await r.json();
    const n = Number.isFinite(j.stargazers_count) ? j.stargazers_count : null;
    if (n == null) return null;
    return { stars: n, stars_display: formatStars(n) };
  } catch {
    return null;
  }
}

// Fetch the latest release tag. Falls back to the most-recent tag if no
// release object exists. Returns null on any failure.
async function fetchVersion(slug) {
  try {
    const r = await fetch(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: HEADERS,
    });
    if (r.ok) {
      const j = await r.json();
      return j.tag_name || j.name || null;
    }
    // 404 → no releases. Try tags list (often projects tag without "release").
    const t = await fetch(`https://api.github.com/repos/${slug}/tags?per_page=1`, {
      headers: HEADERS,
    });
    if (!t.ok) return null;
    const tags = await t.json();
    return Array.isArray(tags) && tags[0]?.name ? tags[0].name : null;
  } catch {
    return null;
  }
}

// Count contributors. GitHub returns a paginated list; the Link header
// of the page=1&per_page=1 response tells us the last page number,
// which equals the total contributor count. If anonymity contribs would
// exceed the 500-page cap, the API caps it. We accept that limit.
async function fetchContributors(slug) {
  try {
    const r = await fetch(
      `https://api.github.com/repos/${slug}/contributors?per_page=1&anon=true`,
      { headers: HEADERS },
    );
    if (!r.ok) return null;
    const link = r.headers.get("link") || "";
    const m = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
    if (m) return Number.parseInt(m[1], 10);
    // No Link header → either 0 or 1 contributor. Parse body.
    const body = await r.json();
    return Array.isArray(body) ? body.length : null;
  } catch {
    return null;
  }
}

async function augmentOne(rec) {
  const slug = slugOf(rec);
  if (!slug) return rec;
  if (!force && rec.version != null && rec.contributors != null) return rec;

  const [version, contributors] = await Promise.all([
    rec.version == null || force ? fetchVersion(slug) : Promise.resolve(rec.version),
    rec.contributors == null || force ? fetchContributors(slug) : Promise.resolve(rec.contributors),
  ]);
  return { ...rec, version: version ?? rec.version ?? null, contributors: contributors ?? rec.contributors ?? null };
}

// Simple pool — GitHub allows 5000 req/h with PAT, but we keep concurrency
// modest so a 143-record run takes ~20s instead of hammering the API.
async function pool(items, fn, concurrency = 8) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (err) {
        console.error(`[augment] item ${idx} failed:`, err.message);
        out[idx] = items[idx];
      }
    }
  });
  await Promise.all(workers);
  return out;
}

const records = JSON.parse(await readFile(path, "utf8"));
console.log(`[augment] loaded ${records.length} records from ${path}`);

let done = 0;
const augmented = await pool(records, async (rec) => {
  const out = await augmentOne(rec);
  done++;
  if (done % 10 === 0) {
    console.log(`[augment] ${done}/${records.length}`);
  }
  return out;
});

const stats = {
  total: augmented.length,
  with_version: augmented.filter((r) => r.version).length,
  with_contributors: augmented.filter((r) => r.contributors != null).length,
};

await writeFile(path, JSON.stringify(augmented, null, 2) + "\n");
console.log(`[augment] wrote ${path}`);
console.log(`[augment] ${stats.with_version}/${stats.total} have version`);
console.log(`[augment] ${stats.with_contributors}/${stats.total} have contributor count`);
