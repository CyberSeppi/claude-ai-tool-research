// Boot-time embedder. Idempotent: chunks already in the store (matched
// by (record_id, chunk_index)) are skipped. Per-record failures are
// isolated — they're counted but don't abort the whole run.
import { createHash } from "node:crypto";
import { buildFieldsChunk } from "./source.mjs";
import { fetchReadme as defaultFetchReadme, splitMarkdown as defaultSplitMd } from "./readme.mjs";

const sha256 = (s) => createHash("sha256").update(s, "utf8").digest("hex");

function repoSlugFromRecord(rec) {
  // Prefer the explicit repo_url; fall back to url only when it
  // points at github. Pure-homepage records (Obsidian etc.) get null
  // and the caller skips the README-fetch path entirely — only the
  // fields-chunk goes in.
  const source = (rec.repo_url && String(rec.repo_url).trim()) || rec.url || "";
  const m = String(source)
    .toLowerCase()
    .match(/github\.com\/([^/]+)\/([^/#?]+)/);
  if (m) return `${m[1]}/${m[2].replace(/\.git$/, "")}`;
  return null;
}

export async function runBackfill({
  records,
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

  for (const rec of records) {
    try {
      // 1) candidate chunks: 1 fields + N readme
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

      // 2) idempotency: skip chunks already in the store
      const needEmbed = [];
      for (const c of candidates) {
        if (store.hasChunk(rec.id, c.chunkIndex)) {
          skipped++;
          continue;
        }
        needEmbed.push({ ...c, textHash: sha256(c.text) });
      }
      if (!needEmbed.length) continue;

      // 3) batch + embed + insert
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
      log.info?.(`[backfill] ${rec.id} embedded=${candidates.length} skipped=${skipped}`);
    } catch (err) {
      failed++;
      log.warn?.(`[backfill] ${rec.id} failed: ${err.message}`);
    }
  }

  return { embedded, skipped, failed };
}
