import { test, expect } from "vitest";
import { matchesQuery } from "./filters";

const rec = { name: "upstash/context7", description: "up-to-date docs", category: "mcp-server", efficiency_gain: "fewer wrong-API retries" } as any;

test("matchesQuery matches across name/description/category/gain, case-insensitive", () => {
  expect(matchesQuery(rec, "context7")).toBe(true);
  expect(matchesQuery(rec, "DOCS")).toBe(true);
  expect(matchesQuery(rec, "mcp")).toBe(true);
  expect(matchesQuery(rec, "retries")).toBe(true);
  expect(matchesQuery(rec, "nonsense")).toBe(false);
});

test("empty query matches everything", () => {
  expect(matchesQuery(rec, "")).toBe(true);
});
