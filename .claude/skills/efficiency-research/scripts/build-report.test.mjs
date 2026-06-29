import { test } from "node:test";
import assert from "node:assert/strict";
import { idOf, matchInstalled, buildReport, validateReport, renderMarkdown } from "./build-report.mjs";

const scan = {
  skills: [{ name: "my-skill", path: "/h/.claude/skills/my-skill" }],
  plugins: [{ name: "cool-plugin", path: "/h/cache/acme/cool-plugin", marketplace: "acme" }],
  mcpServers: [{ name: "context7", source: "/h/.claude.json" }],
  marketplaces: [{ name: "claude-plugins-official", path: "/h/marketplaces/claude-plugins-official", repo: "anthropics/claude-plugins-official" }],
  installedSlugs: ["acme/cool-plugin", "upstash/context7", "some/slug-only"],
  installedNames: ["my-skill", "cool-plugin", "context7"],
};

const raw = [
  { name: "acme/cool-plugin", url: "https://github.com/acme/cool-plugin", category: "plugin-skill", stars: 100, stars_display: "100", description: "d", efficiency_gain: "e", sources: ["https://github.com/acme/cool-plugin"], confidence: "high" },
  { name: "upstash/context7", url: "https://github.com/upstash/context7", category: "mcp-server", stars: 58300, stars_display: "~58k", description: "docs", efficiency_gain: "current docs", sources: ["https://github.com/upstash/context7"], confidence: "high" },
  { name: "foo/bar", url: "https://github.com/foo/bar", category: "token-tool", stars: 5, stars_display: "5", description: "x", efficiency_gain: "y", sources: [], confidence: "low" },
  { name: "acme/cool-plugin", url: "https://github.com/acme/cool-plugin", category: "plugin-skill", description: "dup", efficiency_gain: "", sources: [] },
];

test("idOf builds canonical slug", () => {
  assert.equal(idOf({ url: "https://github.com/Anthropics/Skills" }), "anthropics-skills");
  assert.equal(idOf({ name: "Token Optimizer!" }), "token-optimizer");
});

test("matchInstalled detects by name and by slug, and misses unknown", () => {
  const a = matchInstalled(raw[0], scan);
  assert.equal(a.installed, true);
  assert.equal(a.installed_via, "plugin:acme");
  assert.equal(a.installed_path, "/h/cache/acme/cool-plugin");
  const b = matchInstalled(raw[1], scan);
  assert.equal(b.installed, true);
  assert.equal(b.installed_via, "mcp");
  const c = matchInstalled(raw[2], scan);
  assert.equal(c.installed, false);
  assert.equal(c.installed_path, null);
});

test("matchInstalled resolves marketplace path by name or slug", () => {
  const rec = { name: "anthropics/claude-plugins-official", url: "https://github.com/anthropics/claude-plugins-official", category: "plugin-skill" };
  const m = matchInstalled(rec, scan);
  assert.equal(m.installed, true);
  assert.equal(m.installed_via, "marketplace");
  assert.equal(m.installed_path, "/h/marketplaces/claude-plugins-official");
});

test("matchInstalled keeps slug-only fallback last (marketplace via, null path)", () => {
  const rec = { name: "some/slug-only", url: "https://github.com/some/slug-only", category: "token-tool" };
  const m = matchInstalled(rec, scan);
  assert.equal(m.installed, true);
  assert.equal(m.installed_via, "marketplace");
  assert.equal(m.installed_path, null);
});

test("buildReport dedupes, merges install state, stamps dates", () => {
  const rep = buildReport(raw, scan, { generatedAt: "2026-06-29T00:00:00Z", date: "2026-06-29", query: "q" });
  assert.equal(rep.generated_at, "2026-06-29T00:00:00Z");
  assert.equal(rep.records.length, 3); // dup dropped
  const cool = rep.records.find((r) => r.id === "acme-cool-plugin");
  assert.equal(cool.installed, true);
  assert.equal(cool.last_researched, "2026-06-29");
  assert.equal(cool.confidence, "high");
});

test("buildReport rejects bad category", () => {
  assert.throws(() => buildReport([{ name: "x", url: "https://github.com/a/x", category: "nope" }], scan, { generatedAt: "t", date: "d" }), /category/);
});

test("validateReport throws on missing url", () => {
  const bad = { generated_at: "t", query: "q", records: [{ id: "a", name: "a", category: "token-tool" }] };
  assert.throws(() => validateReport(bad), /url/);
});

test("renderMarkdown groups by category with install marks", () => {
  const rep = buildReport(raw, scan, { generatedAt: "t", date: "2026-06-29", query: "q" });
  const md = renderMarkdown(rep);
  assert.match(md, /## MCP Servers/);
  assert.match(md, /upstash\/context7/);
  assert.match(md, /✓/); // installed marker present
});
