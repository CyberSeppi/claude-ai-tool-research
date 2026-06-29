import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./app.mjs";

const port = Number(process.env.PORT ?? 8787);
const app = createApp();
// serve built SPA from ./dist (present in the container / after `npm run build`)
app.use("/*", serveStatic({ root: "./dist" }));
app.get("/*", serveStatic({ path: "./dist/index.html" }));

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`efficiency-research-app listening on :${info.port}`);
});
