import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { scanInstalled, slugOf, repoName } from "./scan-installed.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const home = join(here, "__fixtures__", "home");

test("slugOf parses github urls", () => {
  assert.equal(slugOf("https://github.com/Upstash/Context7"), "upstash/context7");
  assert.equal(slugOf("git@github.com:acme/cool-plugin.git"), "acme/cool-plugin");
  assert.equal(slugOf("not a url"), null);
});

test("repoName falls back to last segment", () => {
  assert.equal(repoName("https://github.com/anthropics/skills"), "skills");
  assert.equal(repoName("context7"), "context7");
});

test("scanInstalled finds skills, plugins, mcp, slugs, names", async () => {
  const r = await scanInstalled({ home, cwd: join(here, "__fixtures__", "nocwd") });
  const skillNames = r.skills.map((s) => s.name).sort();
  assert.deepEqual(skillNames, ["bundled-skill", "my-skill"]);
  assert.deepEqual(r.plugins.map((p) => p.name), ["cool-plugin"]);
  assert.equal(r.plugins[0].marketplace, "acme");
  assert.deepEqual(r.mcpServers.map((m) => m.name), ["context7"]);
  assert.ok(r.installedSlugs.includes("acme/cool-plugin"));
  assert.ok(r.installedSlugs.includes("upstash/context7"));
  for (const n of ["my-skill", "bundled-skill", "cool-plugin", "context7"]) {
    assert.ok(r.installedNames.includes(n), `missing name ${n}`);
  }
});

const homeRegistry = join(here, "__fixtures__", "home-registry");

test("scanInstalled reads marketplace + plugin registries", async () => {
  const r = await scanInstalled({ home: homeRegistry, cwd: join(here, "__fixtures__", "nocwd") });
  assert.ok(r.installedSlugs.includes("anthropics/claude-plugins-official"), "slug anthropics/claude-plugins-official missing");
  assert.ok(r.installedNames.includes("claude-plugins-official"), "name claude-plugins-official missing");
  assert.ok(r.installedNames.includes("superpowers"), "name superpowers missing");
  const superEntry = r.plugins.find((p) => p.name === "superpowers");
  assert.ok(superEntry, "plugins should contain an entry named superpowers");
  assert.equal(superEntry.marketplace, "claude-plugins-official");
});

test("scanInstalled descends versioned cache layout (cache/<market>/<plugin>/<version>/...)", async () => {
  const r = await scanInstalled({ home: homeRegistry, cwd: join(here, "__fixtures__", "nocwd") });
  // bundled skill lives at .../superpowers/6.0.3/skills/some-skill — one level deeper than <plugin>
  assert.ok(r.skills.some((s) => s.name === "some-skill"), "versioned bundled skill some-skill not detected");
  assert.ok(r.installedNames.includes("some-skill"), "versioned bundled skill name not registered");
  // slug from .../superpowers/6.0.3/.claude-plugin/plugin.json
  assert.ok(r.installedSlugs.includes("test-marketplace/versioned-plugin"), "versioned manifest slug not detected");
});

test("scanInstalled dedupes cache-walk + registry overlap into one plugin entry", async () => {
  const r = await scanInstalled({ home: homeRegistry, cwd: join(here, "__fixtures__", "nocwd") });
  const supers = r.plugins.filter((p) => p.name === "superpowers");
  assert.equal(supers.length, 1, "superpowers should collapse to a single plugin entry");
});

test("scanInstalled returns marketplaces with installLocation path + repo slug", async () => {
  const r = await scanInstalled({ home: homeRegistry, cwd: join(here, "__fixtures__", "nocwd") });
  const mk = r.marketplaces.find((m) => m.name === "claude-plugins-official");
  assert.ok(mk, "marketplace claude-plugins-official missing");
  assert.equal(mk.path, "/home/testuser/.claude/plugins/marketplaces/claude-plugins-official");
  assert.equal(mk.repo, "anthropics/claude-plugins-official");
});

const homeNarrow = join(here, "__fixtures__", "home-narrow");

test("scanInstalled only scans mcpServers configs for slugs in ~/.claude.json (not whole file)", async () => {
  const r = await scanInstalled({ home: homeNarrow, cwd: join(here, "__fixtures__", "nocwd") });
  assert.ok(r.installedSlugs.includes("upstash/context7"), "mcpServers slug should be detected");
  assert.ok(!r.installedSlugs.includes("unrelated/should-not-match"), "unrelated top-level url must NOT be treated as installed");
});
