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
