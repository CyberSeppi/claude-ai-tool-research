import { test } from "node:test";
import assert from "node:assert/strict";
import { enrichFromUrl, isGithubUrl } from "./enrich.mjs";

test("isGithubUrl: matches https github repo url", () => {
  assert.equal(isGithubUrl("https://github.com/foo/bar"), true);
  assert.equal(isGithubUrl("https://github.com/foo/bar/tree/main"), true);
  assert.equal(isGithubUrl("https://obsidian.md"), false);
  assert.equal(isGithubUrl("https://github.com/foo"), false);
});

test("enrichFromUrl: github path fills stars/version/contributors", async () => {
  const fetchImpl = async (u) => {
    if (u.endsWith("/repos/foo/bar")) {
      return new Response(
        JSON.stringify({
          stargazers_count: 1234,
          description: "from gh",
          license: { spdx_id: "MIT" },
          topics: ["claude-code", "rag"],
        }),
        { status: 200 },
      );
    }
    if (u.includes("/releases/latest")) {
      return new Response(JSON.stringify({ tag_name: "v2.0.0" }), { status: 200 });
    }
    if (u.includes("/contributors")) {
      return new Response("[]", {
        status: 200,
        headers: { link: '<...&page=42>; rel="last"' },
      });
    }
    throw new Error("unexpected " + u);
  };
  const out = await enrichFromUrl({
    url: "https://github.com/foo/bar",
    githubToken: "ghp_x",
    llm: null,
    fetchImpl,
  });
  assert.equal(out.name, "foo/bar");
  assert.equal(out.url, "https://github.com/foo/bar");
  assert.equal(out.repo_url, "https://github.com/foo/bar");
  assert.equal(out.stars, 1234);
  assert.equal(out.stars_display, "1.2k");
  assert.equal(out.version, "v2.0.0");
  assert.equal(out.contributors, 42);
  assert.equal(out.description, "from gh");
  // No LLM call on the github path → free is null
  assert.equal(out.free, null);
});

test("enrichFromUrl: homepage path runs LLM extraction", async () => {
  const fetchImpl = async (u) => {
    if (u === "https://obsidian.md") {
      return new Response("<html><body>Obsidian: free markdown PKM</body></html>", {
        status: 200,
      });
    }
    throw new Error("unexpected fetch " + u);
  };
  const llmCalls = [];
  const llm = {
    chat: async (messages) => {
      llmCalls.push(messages);
      return JSON.stringify({
        description: "Local-first Markdown knowledge base",
        efficiency_gain: "External memory layer for Claude",
        use_cases: ["knowledge-tool", "note-taking", "rag"],
        category: "companion-app",
        free: true,
        free_check_reason: "Homepage shows 'Free for personal use'",
      });
    },
  };
  const out = await enrichFromUrl({
    url: "https://obsidian.md",
    name: "Obsidian",
    githubToken: "ghp_x",
    llm,
    fetchImpl,
  });
  assert.equal(out.name, "Obsidian");
  assert.equal(out.url, "https://obsidian.md");
  assert.equal(out.repo_url, null);
  assert.equal(out.category, "companion-app");
  assert.equal(out.free, true);
  assert.match(out.description, /knowledge base/);
  assert.equal(llmCalls.length, 1);
});

test("enrichFromUrl: homepage LLM returns invalid JSON → throws", async () => {
  const fetchImpl = async () => new Response("<html></html>", { status: 200 });
  const llm = { chat: async () => "this is not json" };
  await assert.rejects(
    () => enrichFromUrl({ url: "https://example.com", llm, fetchImpl }),
    /enrich/i,
  );
});

test("enrichFromUrl: github 404 → throws", async () => {
  const fetchImpl = async () => new Response("not found", { status: 404 });
  await assert.rejects(
    () =>
      enrichFromUrl({
        url: "https://github.com/missing/repo",
        githubToken: "ghp_x",
        llm: null,
        fetchImpl,
      }),
    /repo not found|404/i,
  );
});
