import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  slugOf,
  readSeeds,
  writeSeedsAtomic,
  addSeed,
  updateSeed,
  deleteSeed,
} from "./seeds.mjs";

function tmp() {
  return mkdtempSync(join(tmpdir(), "seeds-"));
}

test("slugOf: github url → owner/repo lowercase, .git stripped", () => {
  assert.equal(
    slugOf({ url: "https://github.com/Foo/Bar.git" }),
    "foo/bar",
  );
});

test("slugOf: repo_url wins over url", () => {
  assert.equal(
    slugOf({
      url: "https://obsidian.md",
      repo_url: "https://github.com/obsidianmd/obsidian-releases",
    }),
    "obsidianmd/obsidian-releases",
  );
});

test("slugOf: non-github → lower(name)", () => {
  assert.equal(slugOf({ url: "https://obsidian.md", name: "Obsidian" }), "obsidian");
});

test("readSeeds: missing file → empty array", () => {
  const dir = tmp();
  try {
    assert.deepEqual(readSeeds(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("writeSeedsAtomic: writes to .tmp then renames; no .tmp leftover", () => {
  const dir = tmp();
  try {
    writeSeedsAtomic(dir, [{ name: "X", url: "https://x", category: "plugin-skill" }]);
    assert.equal(existsSync(join(dir, "seeds.json")), true);
    assert.equal(existsSync(join(dir, "seeds.json.tmp")), false);
    const parsed = JSON.parse(readFileSync(join(dir, "seeds.json"), "utf8"));
    assert.equal(parsed.records.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addSeed: appends + stamps added_at/updated_at", () => {
  const dir = tmp();
  try {
    const now = new Date("2026-06-30T10:00:00Z");
    const { seed } = addSeed(
      dir,
      { name: "X", url: "https://x", category: "plugin-skill" },
      now,
    );
    assert.equal(seed.name, "X");
    assert.equal(seed.added_at, now.toISOString());
    assert.equal(seed.updated_at, now.toISOString());
    assert.equal(readSeeds(dir).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("addSeed: slug collision throws SLUG_EXISTS_SEED", () => {
  const dir = tmp();
  try {
    addSeed(dir, { name: "A", url: "https://github.com/x/y", category: "plugin-skill" });
    assert.throws(
      () =>
        addSeed(dir, {
          name: "A2",
          url: "https://github.com/x/y",
          category: "plugin-skill",
        }),
      /SLUG_EXISTS_SEED/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateSeed: patches fields + bumps updated_at; rejects unknown slug", () => {
  const dir = tmp();
  try {
    const t1 = new Date("2026-06-30T10:00:00Z");
    addSeed(
      dir,
      { name: "X", url: "https://x", category: "plugin-skill" },
      t1,
    );
    const t2 = new Date("2026-06-30T11:00:00Z");
    const { seed } = updateSeed(dir, "x", { description: "new" }, t2);
    assert.equal(seed.description, "new");
    assert.equal(seed.added_at, t1.toISOString());
    assert.equal(seed.updated_at, t2.toISOString());
    assert.throws(() => updateSeed(dir, "nope", {}), /NO_SUCH_SEED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("deleteSeed: removes when present; false when absent", () => {
  const dir = tmp();
  try {
    addSeed(dir, { name: "X", url: "https://x", category: "plugin-skill" });
    assert.equal(deleteSeed(dir, "x"), true);
    assert.equal(deleteSeed(dir, "x"), false);
    assert.deepEqual(readSeeds(dir), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
