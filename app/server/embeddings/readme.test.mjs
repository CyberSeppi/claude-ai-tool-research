import { test } from "node:test";
import assert from "node:assert/strict";
import { splitMarkdown, fetchReadme } from "./readme.mjs";

const SAMPLE = `# Acme MCP Server

A quick blurb.

## Installation

Run \`npm install\`.

## Usage

Some text.

### Config

Tiny details.
`;

test("splitMarkdown: emits a chunk per ## section with heading path", () => {
  const chunks = splitMarkdown(SAMPLE, "owner/repo", 1500);
  const paths = chunks.map((c) => c.headingPath);
  assert.deepEqual(paths, [
    "owner/repo: Acme MCP Server",
    "owner/repo: Acme MCP Server > Installation",
    "owner/repo: Acme MCP Server > Usage",
    "owner/repo: Acme MCP Server > Usage > Config",
  ]);
});

test("splitMarkdown: each chunk text starts with its heading path prefix", () => {
  const chunks = splitMarkdown(SAMPLE, "owner/repo", 1500);
  for (const c of chunks) {
    assert.ok(c.text.startsWith(c.headingPath), `expected prefix for chunk:\n${c.text}`);
  }
});

test("splitMarkdown: oversized section gets char-split", () => {
  const big = "# Big\n\n" + "x".repeat(4000);
  const chunks = splitMarkdown(big, "o/r", 1500);
  assert.ok(chunks.length >= 3, `expected ≥3 chunks, got ${chunks.length}`);
});

test("splitMarkdown: no headings → single chunk", () => {
  const chunks = splitMarkdown("Just plain text.", "o/r", 1500);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].headingPath, "o/r");
});

test("splitMarkdown: empty input → empty array", () => {
  assert.deepEqual(splitMarkdown("", "o/r", 1500), []);
  assert.deepEqual(splitMarkdown("   \n  ", "o/r", 1500), []);
});

test("fetchReadme: returns null on 404", async () => {
  const fetchImpl = async () => new Response("", { status: 404 });
  assert.equal(await fetchReadme({ repoSlug: "x/y", githubToken: "t", fetchImpl }), null);
});

test("fetchReadme: returns null on 401", async () => {
  const fetchImpl = async () => new Response("", { status: 401 });
  assert.equal(await fetchReadme({ repoSlug: "x/y", githubToken: "t", fetchImpl }), null);
});

test("fetchReadme: returns text on 200", async () => {
  const fetchImpl = async () => new Response("# Hi\n\nbody", { status: 200 });
  assert.equal(await fetchReadme({ repoSlug: "x/y", githubToken: "t", fetchImpl }), "# Hi\n\nbody");
});

test("fetchReadme: passes Bearer token + raw accept header", async () => {
  let captured = null;
  const fetchImpl = async (url, init) => {
    captured = { url, init };
    return new Response("ok", { status: 200 });
  };
  await fetchReadme({ repoSlug: "x/y", githubToken: "GHP", fetchImpl });
  assert.equal(captured.url, "https://api.github.com/repos/x/y/readme");
  assert.equal(captured.init.headers["Authorization"], "Bearer GHP");
  assert.equal(captured.init.headers["Accept"], "application/vnd.github.raw");
});

test("fetchReadme: null when token missing", async () => {
  const fetchImpl = async () => new Response("ok", { status: 200 });
  assert.equal(await fetchReadme({ repoSlug: "x/y", githubToken: "", fetchImpl }), null);
});

test("fetchReadme: null when slug missing", async () => {
  const fetchImpl = async () => new Response("ok", { status: 200 });
  assert.equal(await fetchReadme({ repoSlug: "", githubToken: "t", fetchImpl }), null);
});
