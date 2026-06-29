import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.mjs";
import { createLlmClient } from "./llm/index.mjs";

const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.DATA_DIR ?? "../data";
const dbDir = process.env.DB_DIR ?? "./db";

// Construct the LLM client at boot — fails fast on missing secrets.
// Embeddings + RAG come in a later slice; for now we wire only chat
// with the full-context fallback path.
const llm = createLlmClient();

const app = createApp({ dataDir, dbDir, llm, embeddingsCfg: { enabled: false } });
app.use("/*", serveStatic({ root: "./dist" }));
app.get("/*", serveStatic({ path: "./dist/index.html" }));

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`efficiency-research-app listening on :${info.port}`);
});
