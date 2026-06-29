import { Hono } from "hono";
import { loadReport } from "./data.mjs";
import { readFlags, setFlag } from "./flags.mjs";
import { buildChatContext } from "./chat.mjs";
import { askClaude } from "./claude.mjs";

export function createApp(opts = {}) {
  const dataDir = opts.dataDir ?? process.env.DATA_DIR ?? "../data";
  const dbDir = opts.dbDir ?? process.env.DB_DIR ?? "./db";
  const app = new Hono();
  app.get("/api/health", (c) => c.json({ ok: true }));
  app.get("/api/records", (c) => {
    const { generated_at, records } = loadReport(dataDir);
    const flags = readFlags(dbDir);
    const merged = records.map((r) => ({
      ...r,
      flagged: Boolean(flags[r.id]?.interesting),
      note: flags[r.id]?.note ?? "",
    }));
    return c.json({ generated_at, records: merged });
  });
  app.post("/api/refresh", (c) => {
    const { generated_at, records } = loadReport(dataDir);
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
    const { records } = loadReport(dataDir);
    const flags = readFlags(dbDir);
    const merged = records.map((r) => ({ ...r, flagged: Boolean(flags[r.id]?.interesting) }));
    const context = buildChatContext(merged, scope, ids);
    try {
      const answer = await askClaude(`${context}\n\n---\nUser question: ${message}`);
      return c.json({ answer });
    } catch (err) {
      console.error("[/api/chat]", err);
      return c.json({ error: "chat request failed" }, 502);
    }
  });
  return app;
}
