import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadReport } from "./data.mjs";
import { createApp } from "./app.mjs";

const baseRaw = {
  generated_at: "2026-06-30T00:00:00Z",
  query: "q",
  records: [
    {
      id: "a-b",
      name: "a/b",
      url: "https://github.com/a/b",
      repo_url: "https://github.com/a/b",
      category: "mcp-server",
      stars: 100,
      stars_display: "100",
      version: "v1",
      contributors: 5,
      description: "raw desc",
      efficiency_gain: "raw gain",
      sources: [],
      confidence: "high",
      use_cases: ["dev"],
      last_researched: "2026-06-30",
    },
  ],
};

test("loadReport: no seeds → raw records pass through, curated=false", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "data-"));
  const dbDir = await mkdtemp(join(tmpdir(), "db-"));
  try {
    await writeFile(join(dataDir, "report.json"), JSON.stringify(baseRaw));
    const r = loadReport(dataDir, dbDir);
    assert.equal(r.records.length, 1);
    assert.equal(r.records[0].curated, false);
    assert.equal(r.records[0].description, "raw desc");
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
});

test("loadReport: seed-only record appears with curated=true", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "data-"));
  const dbDir = await mkdtemp(join(tmpdir(), "db-"));
  try {
    await writeFile(join(dataDir, "report.json"), JSON.stringify(baseRaw));
    await writeFile(
      join(dbDir, "seeds.json"),
      JSON.stringify({
        records: [
          {
            name: "Obsidian",
            url: "https://obsidian.md",
            category: "companion-app",
            description: "curated",
            efficiency_gain: "curated gain",
            use_cases: ["knowledge-tool"],
            sources: [],
            confidence: "high",
            added_at: "2026-06-30T10:00:00Z",
            updated_at: "2026-06-30T10:00:00Z",
          },
        ],
      }),
    );
    const r = loadReport(dataDir, dbDir);
    const obs = r.records.find((x) => x.name === "Obsidian");
    assert.ok(obs);
    assert.equal(obs.curated, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
});

test("loadReport: seed wins on slug collision; null augment fields fall back to raw", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "data-"));
  const dbDir = await mkdtemp(join(tmpdir(), "db-"));
  try {
    await writeFile(join(dataDir, "report.json"), JSON.stringify(baseRaw));
    await writeFile(
      join(dbDir, "seeds.json"),
      JSON.stringify({
        records: [
          {
            name: "a/b",
            url: "https://github.com/a/b",
            category: "mcp-server",
            description: "OVERRIDE",
            efficiency_gain: "OVERRIDE gain",
            stars: null,
            version: null,
            contributors: null,
            sources: [],
            confidence: "high",
            use_cases: ["dev"],
          },
        ],
      }),
    );
    const r = loadReport(dataDir, dbDir);
    const x = r.records.find((y) => y.name === "a/b");
    assert.equal(x.description, "OVERRIDE", "seed beats raw on description");
    assert.equal(x.stars, 100, "raw stars preserved when seed is null");
    assert.equal(x.version, "v1", "raw version preserved when seed is null");
    assert.equal(x.curated, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
});

test("loadReport: sort order is stars desc with null last", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "data-"));
  const dbDir = await mkdtemp(join(tmpdir(), "db-"));
  try {
    await writeFile(
      join(dataDir, "report.json"),
      JSON.stringify({
        ...baseRaw,
        records: [
          {
            ...baseRaw.records[0],
            id: "low",
            name: "low",
            url: "https://github.com/low/repo",
            repo_url: "https://github.com/low/repo",
            stars: 10,
          },
          {
            ...baseRaw.records[0],
            id: "high",
            name: "high",
            url: "https://github.com/high/repo",
            repo_url: "https://github.com/high/repo",
            stars: 1000,
          },
        ],
      }),
    );
    await writeFile(
      join(dbDir, "seeds.json"),
      JSON.stringify({
        records: [
          {
            name: "no-stars-seed",
            url: "https://x.example",
            category: "companion-app",
            description: "x",
            efficiency_gain: "x",
            stars: null,
            sources: [],
            confidence: "high",
            use_cases: [],
          },
        ],
      }),
    );
    const r = loadReport(dataDir, dbDir);
    assert.deepEqual(
      r.records.map((x) => x.name),
      ["high", "low", "no-stars-seed"],
    );
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
});

test("GET /api/records: surfaces curated + merged records", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "app-data-"));
  const dbDir = await mkdtemp(join(tmpdir(), "app-db-"));
  try {
    await writeFile(join(dataDir, "report.json"), JSON.stringify(baseRaw));
    await mkdir(dbDir, { recursive: true });
    await writeFile(
      join(dbDir, "seeds.json"),
      JSON.stringify({
        records: [
          {
            name: "Obsidian",
            url: "https://obsidian.md",
            category: "companion-app",
            description: "d",
            efficiency_gain: "e",
            stars: null,
            sources: [],
            confidence: "high",
            use_cases: [],
            added_at: "2026-06-30T00:00:00Z",
            updated_at: "2026-06-30T00:00:00Z",
          },
        ],
      }),
    );
    const app = createApp({ dataDir, dbDir });
    const res = await app.request("/api/records");
    assert.equal(res.status, 200);
    const body = await res.json();
    const obs = body.records.find((r) => r.name === "Obsidian");
    assert.ok(obs);
    assert.equal(obs.curated, true);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
    await rm(dbDir, { recursive: true, force: true });
  }
});
