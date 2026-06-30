import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { join } from "node:path";
import { ProxyAgent, setGlobalDispatcher, getGlobalDispatcher } from "undici";
import { createApp } from "./app.mjs";
import { loadReport } from "./data.mjs";
import { createLlmClient } from "./llm/index.mjs";
import { createOAuthClient } from "./llm/oauth.mjs";
import { loadEmbeddingsConfig } from "./embeddings/config.mjs";
import { createEmbeddingsClient } from "./embeddings/client.mjs";
import { createEmbeddingsStore } from "./embeddings/store.mjs";
import { createRetriever } from "./embeddings/retrieve.mjs";
import { runBackfill, indexRecord } from "./embeddings/backfill.mjs";
import { enrichFromUrl } from "./enrich.mjs";

// Honour HTTPS_PROXY / NO_PROXY for outbound fetch() calls. Node's
// built-in undici-based fetch ignores those env vars by default; setting
// a ProxyAgent + noProxy list makes the GitHub README fetcher (and any
// other outbound call) go through the corporate egress proxy.
const proxyUrl = process.env.HTTPS_PROXY || process.env.https_proxy || "";
const noProxy = process.env.NO_PROXY || process.env.no_proxy || "";
if (proxyUrl) {
  const noProxyHosts = noProxy
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  setGlobalDispatcher(
    new ProxyAgent({
      uri: proxyUrl,
      // The noProxy option matches host suffixes (".example.com") and
      // exact hosts ("localhost"). CIDR ranges are not understood by
      // undici — those entries are silently ignored, which is fine
      // because the BMW gateway is name-based.
      ...(noProxyHosts.length ? { noProxy: noProxyHosts } : {}),
    }),
  );
  console.log(`[boot] outbound proxy: ${proxyUrl} (noProxy: ${noProxyHosts.length} entries)`);
}

const port = Number(process.env.PORT ?? 8787);
const dataDir = process.env.DATA_DIR ?? "../data";
const dbDir = process.env.DB_DIR ?? "./db";

// LLM client first — fails fast on missing secrets.
const llm = createLlmClient();

// Embeddings layer — optional, gated by EMBEDDINGS_ENABLED.
const embeddingsCfg = loadEmbeddingsConfig();
let retriever = null;
let embClient = null;
let embStore = null;
if (embeddingsCfg.enabled) {
  const oauth = createOAuthClient({ ...embeddingsCfg.auth, fetchImpl: fetch });
  embClient = createEmbeddingsClient({ getConfig: () => embeddingsCfg, oauth });
  embStore = createEmbeddingsStore({
    dbPath: join(dbDir, "embeddings.sqlite"),
    model: embeddingsCfg.model,
    promptVersion: embeddingsCfg.promptVersion,
  });
  if (embeddingsCfg.backfillOnStartup) {
    const { records } = loadReport(dataDir, dbDir);
    console.log(`[boot] embeddings backfill starting for ${records.length} records…`);
    const result = await runBackfill({
      records,
      client: embClient,
      store: embStore,
      config: embeddingsCfg,
    });
    console.log(
      `[boot] embeddings backfill: embedded=${result.embedded} skipped=${result.skipped} failed=${result.failed}`,
    );
  }
  retriever = createRetriever({ client: embClient, store: embStore, config: embeddingsCfg });
}

// Real enrich: closes over the LLM client and the GITHUB_TOKEN env var.
const enrich = (input) =>
  enrichFromUrl({
    url: input.url,
    name: input.name,
    githubToken: process.env.GITHUB_TOKEN,
    llm,
  });

// Real indexer: fires when POST /api/seeds saves a record. Same client,
// store, config as the boot backfill — the text_hash gate makes
// concurrent boot + indexer safe.
const indexer =
  embClient && embStore
    ? (rec) =>
        indexRecord(rec, {
          client: embClient,
          store: embStore,
          config: embeddingsCfg,
        }).catch((err) => console.error("[index] failed:", err))
    : null;

const app = createApp({ dataDir, dbDir, llm, retriever, embeddingsCfg, enrich, indexer });
app.use("/*", serveStatic({ root: "./dist" }));
app.get("/*", serveStatic({ path: "./dist/index.html" }));

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`efficiency-research-app listening on :${info.port}`);
});
