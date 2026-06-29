import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatContext } from "./chat.mjs";

const records = [
  { id: "a-b", name: "a/b", category: "mcp-server", stars_display: "5", installed: true, description: "desc-b", efficiency_gain: "gain-b", url: "https://github.com/a/b" },
  { id: "c-d", name: "c/d", category: "token-tool", stars_display: "9", installed: false, description: "desc-d", efficiency_gain: "gain-d", url: "https://github.com/c/d" },
];

test("record scope includes the single record's details", () => {
  const ctx = buildChatContext(records, "record", ["a-b"]);
  assert.match(ctx, /a\/b/);
  assert.match(ctx, /desc-b/);
  assert.doesNotMatch(ctx, /c\/d/);
});

test("selection scope includes only chosen records and asks to compare", () => {
  const ctx = buildChatContext(records, "selection", ["a-b", "c-d"]);
  assert.match(ctx, /a\/b/);
  assert.match(ctx, /c\/d/);
  assert.match(ctx, /compare/i);
});

test("global scope includes all records and asks to compare/rate", () => {
  const ctx = buildChatContext(records, "global", []);
  assert.match(ctx, /a\/b/);
  assert.match(ctx, /c\/d/);
  assert.match(ctx, /rate|compare/i);
});
