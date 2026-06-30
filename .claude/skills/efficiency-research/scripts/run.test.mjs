import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "./build-report.mjs";

test("run builds + writes valid report.json + report.md", async () => {
  const dir = await mkdtemp(join(tmpdir(), "effres-"));
  try {
    const rawPath = join(dir, "raw-records.json");
    await writeFile(
      rawPath,
      JSON.stringify([
        {
          name: "upstash/context7",
          url: "https://github.com/upstash/context7",
          category: "mcp-server",
          stars: 58300,
          stars_display: "~58k",
          version: "v3.1.0",
          contributors: 18,
          description: "docs",
          efficiency_gain: "current docs",
          sources: [],
          confidence: "high",
        },
      ]),
    );
    const out = join(dir, "data");
    await mkdir(out, { recursive: true });
    const res = await run({
      rawRecordsPath: rawPath,
      outDir: out,
      now: new Date("2026-06-29T00:00:00Z"),
      query: "q",
    });
    const json = JSON.parse(await readFile(res.jsonPath, "utf8"));
    assert.equal(json.records.length, 1);
    assert.equal(json.records[0].version, "v3.1.0");
    assert.equal(json.records[0].contributors, 18);
    assert.equal(json.records[0].last_researched, "2026-06-29");
    const md = await readFile(res.mdPath, "utf8");
    assert.match(md, /upstash\/context7/);
    assert.match(md, /v3\.1\.0/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
