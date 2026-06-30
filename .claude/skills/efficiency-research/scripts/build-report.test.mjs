import { test } from "node:test";
import assert from "node:assert/strict";
import { idOf, buildReport, validateReport, renderMarkdown } from "./build-report.mjs";

const raw = [
  {
    name: "acme/cool-plugin",
    url: "https://github.com/acme/cool-plugin",
    category: "plugin-skill",
    stars: 100,
    stars_display: "100",
    version: "v1.2.3",
    contributors: 42,
    description: "d",
    efficiency_gain: "e",
    sources: ["https://github.com/acme/cool-plugin"],
    confidence: "high",
  },
  {
    name: "upstash/context7",
    url: "https://github.com/upstash/context7",
    category: "mcp-server",
    stars: 58300,
    stars_display: "~58k",
    description: "docs",
    efficiency_gain: "current docs",
    sources: ["https://github.com/upstash/context7"],
    confidence: "high",
  },
  {
    name: "foo/bar",
    url: "https://github.com/foo/bar",
    category: "token-tool",
    stars: 5,
    stars_display: "5",
    description: "x",
    efficiency_gain: "y",
    sources: [],
    confidence: "low",
  },
  {
    name: "acme/cool-plugin",
    url: "https://github.com/acme/cool-plugin",
    category: "plugin-skill",
    description: "dup",
    efficiency_gain: "",
    sources: [],
  },
];

test("idOf builds canonical slug", () => {
  assert.equal(idOf({ url: "https://github.com/Anthropics/Skills" }), "anthropics-skills");
  assert.equal(idOf({ name: "Token Optimizer!" }), "token-optimizer");
});

test("buildReport dedupes, propagates version/contributors, stamps dates", () => {
  const rep = buildReport(raw, {
    generatedAt: "2026-06-29T00:00:00Z",
    date: "2026-06-29",
    query: "q",
  });
  assert.equal(rep.generated_at, "2026-06-29T00:00:00Z");
  assert.equal(rep.records.length, 3); // dup dropped
  const cool = rep.records.find((r) => r.id === "acme-cool-plugin");
  assert.equal(cool.version, "v1.2.3");
  assert.equal(cool.contributors, 42);
  assert.equal(cool.last_researched, "2026-06-29");
  assert.equal(cool.confidence, "high");
});

test("buildReport defaults missing version/contributors to null", () => {
  const rep = buildReport(raw, { generatedAt: "t", date: "2026-06-29" });
  const bar = rep.records.find((r) => r.id === "foo-bar");
  assert.equal(bar.version, null);
  assert.equal(bar.contributors, null);
});

test("buildReport rejects bad category", () => {
  assert.throws(
    () =>
      buildReport([{ name: "x", url: "https://github.com/a/x", category: "nope" }], {
        generatedAt: "t",
        date: "d",
      }),
    /category/,
  );
});

test("validateReport throws on missing url", () => {
  const bad = {
    generated_at: "t",
    query: "q",
    records: [{ id: "a", name: "a", category: "token-tool" }],
  };
  assert.throws(() => validateReport(bad), /url/);
});

test("renderMarkdown groups by category with version + contributors columns", () => {
  const rep = buildReport(raw, { generatedAt: "t", date: "2026-06-29", query: "q" });
  const md = renderMarkdown(rep);
  assert.match(md, /## MCP Servers/);
  assert.match(md, /upstash\/context7/);
  assert.match(md, /\| Version \| Contributors \|/);
  assert.match(md, /v1\.2\.3/);
  assert.match(md, /\| 42 \|/);
});

test("buildReport: accepts companion-app as a category", () => {
  const rep = buildReport(
    [
      {
        name: "Obsidian",
        url: "https://obsidian.md",
        repo_url: "https://github.com/obsidianmd/obsidian-releases",
        category: "companion-app",
        description: "PKM",
        efficiency_gain: "external memory",
        sources: [],
        confidence: "high",
        use_cases: ["knowledge-tool"],
      },
    ],
    { generatedAt: "t", date: "2026-06-30" },
  );
  assert.equal(rep.records.length, 1);
  assert.equal(rep.records[0].category, "companion-app");
  assert.equal(rep.records[0].repo_url, "https://github.com/obsidianmd/obsidian-releases");
});

test("buildReport: fallback — github url + no repo_url → repo_url = url", () => {
  const rep = buildReport(
    [
      {
        name: "acme/x",
        url: "https://github.com/acme/x",
        category: "plugin-skill",
        description: "d",
        efficiency_gain: "e",
        sources: [],
        confidence: "high",
        use_cases: ["dev"],
      },
    ],
    { generatedAt: "t", date: "2026-06-30" },
  );
  assert.equal(rep.records[0].repo_url, "https://github.com/acme/x");
});

test("buildReport: non-github url + no repo_url → repo_url stays null", () => {
  const rep = buildReport(
    [
      {
        name: "Obsidian",
        url: "https://obsidian.md",
        category: "companion-app",
        description: "PKM",
        efficiency_gain: "e",
        sources: [],
        confidence: "high",
        use_cases: ["knowledge-tool"],
      },
    ],
    { generatedAt: "t", date: "2026-06-30" },
  );
  assert.equal(rep.records[0].repo_url, null);
});
