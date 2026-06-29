import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { join } from "node:path";
import { createApp } from "./app.mjs";
import { loadReport } from "./data.mjs";
import { createLlmClient } from "./llm/index.mjs";
import { createOAuthClient } from "./llm/oauth.mjs";
import { loadEmbeddingsConfig } from "./embeddings/config.mjs";
import { createEmbeddingsClient } from "./embeddings/client.mjs";
import { createEmbeddingsStore } from "./embeddings/store.mjs";
import { createRetriever } from "./embeddings/retrieve.mjs";
import { runBackfill } from "./embeddings/backfill.mjs";

const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.DATA_DIR ?? "../data";
const dbDir = process.env.DB_DIR ?? "./db";

// LLM client first — fails fast on missing secrets.
const llm = createLlmClient();

// Embeddings layer — optional, gated by EMBEDDINGS_ENABLED.
const embeddingsCfg = loadEmbeddingsConfig();
let retriever = null;
if (embeddingsCfg.enabled) {
  const oauth = createOAuthClient({ ...embeddingsCfg.auth, fetchImpl: fetch });
  const client = createEmbeddingsClient({ getConfig: () => embeddingsCfg, oauth });
  const store = createEmbeddingsStore({
    dbPath: join(dbDir, "embeddings.sqlite"),
    model: embeddingsCfg.model,
    promptVersion: embeddingsCfg.promptVersion,
  });
  if (embeddingsCfg.backfillOnStartup) {
    const { records } = loadReport(dataDir);
    console.log(`[boot] embeddings backfill starting for ${records.length} records…`);
    const result = await runBackfill({ records, client, store, config: embeddingsCfg });
    console.log(
      `[boot] embeddings backfill: embedded=${result.embedded} skipped=${result.skipped} failed=${result.failed}`,
    );
  }
  retriever = createRetriever({ client, store, config: embeddingsCfg });
}

const app = createApp({ dataDir, dbDir, llm, retriever, embeddingsCfg });
app.use("/*", serveStatic({ root: "./dist" }));
app.get("/*", serveStatic({ path: "./dist/index.html" }));

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`efficiency-research-app listening on :${info.port}`);
});
