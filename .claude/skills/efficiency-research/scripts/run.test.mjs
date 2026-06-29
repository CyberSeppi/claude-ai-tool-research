import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { run } from "./build-report.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const home = join(here, "__fixtures__", "home");

test("run scans, builds, writes valid report.json + report.md", async () => {
  const dir = await mkdtemp(join(tmpdir(), "effres-"));
  try {
    const rawPath = join(dir, "raw-records.json");
    await writeFile(rawPath, JSON.stringify([
      { name: "upstash/context7", url: "https://github.com/upstash/context7", category: "mcp-server", stars: 58300, stars_display: "~58k", description: "docs", efficiency_gain: "current docs", sources: [], confidence: "high" },
    ]));
    const out = join(dir, "data");
    await mkdir(out, { recursive: true });
    const res = await run({ rawRecordsPath: rawPath, outDir: out, home, cwd: join(here, "nocwd"), now: new Date("2026-06-29T00:00:00Z"), query: "q" });
    const json = JSON.parse(await readFile(res.jsonPath, "utf8"));
    assert.equal(json.records.length, 1);
    assert.equal(json.records[0].installed, true); // context7 in fixture .claude.json
    assert.equal(json.records[0].last_researched, "2026-06-29");
    const md = await readFile(res.mdPath, "utf8");
    assert.match(md, /upstash\/context7/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
