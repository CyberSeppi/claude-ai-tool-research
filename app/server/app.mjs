import { Hono } from "hono";
import { loadReport } from "./data.mjs";
import { readFlags, setFlag } from "./flags.mjs";
import { runChat } from "./chat.mjs";
import { addSeed, updateSeed, deleteSeed, slugOf, readSeeds } from "./seeds.mjs";
import { enrichFromUrl } from "./enrich.mjs";

export function createApp(opts = {}) {
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? "../data";
  const dbDir = opts.dbDir ?? process.env.DB_DIR ?? "./db";
  const llm = opts.llm ?? null;                   // injected — no default LLM here
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

  const app = new Hono();
  app.get("/api/health", (c) => c.json({ ok: true }));

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

  app.post("/api/records/:id/flag", async (c) => {
    const id = c.req.param("id");
    const patch = await c.req.json().catch(() => ({}));
    const flag = setFlag(dbDir, id, {
      interesting: typeof patch.interesting === "boolean" ? patch.interesting : undefined,
      note: typeof patch.note === "string" ? patch.note : undefined,
    });
    return c.json({ id, flag });
  });

  app.post("/api/chat", async (c) => {
    const { scope = "global", ids = [], message = "" } = await c.req.json().catch(() => ({}));
    if (!message.trim()) return c.json({ error: "empty message" }, 400);
    if (!llm) return c.json({ error: "chat not configured" }, 503);

    const { records } = loadReport(dataDir, dbDir);
    const flags = readFlags(dbDir);
    const merged = records.map((r) => ({ ...r, flagged: Boolean(flags[r.id]?.interesting) }));

    try {
      const { answer, retrieval } = await runChat({
        records: merged,
        scope,
        ids,
        message,
        llm,
        retriever,
        embeddingsCfg,
      });
      return c.json({ answer, retrieval });
    } catch (err) {
      console.error("[/api/chat]", err);
      return c.json({ error: "chat request failed" }, 502);
    }
  });

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

  return app;
}
