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
