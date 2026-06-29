import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatContext, runChat } from "./chat.mjs";

const records = [
  {
    id: "a-b",
    name: "a/b",
    category: "mcp-server",
    stars_display: "5",
    installed: true,
    description: "desc-b",
    efficiency_gain: "gain-b",
    url: "https://github.com/a/b",
    use_cases: ["rag"],
  },
  {
    id: "c-d",
    name: "c/d",
    category: "token-tool",
    stars_display: "9",
    installed: false,
    description: "desc-d",
    efficiency_gain: "gain-d",
    url: "https://github.com/c/d",
    use_cases: ["dev"],
  },
];

// ── buildChatContext (kept as-is so the legacy contract is locked in) ──
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

// ── runChat ──────────────────────────────────────────────────────────
const stubLlm = { chat: async (msgs) => `LLM saw ${msgs.length} messages` };

test("runChat: scope=record returns full-context mode", async () => {
  const out = await runChat({
    records,
    scope: "record",
    ids: ["a-b"],
    message: "what is it?",
    llm: stubLlm,
    embeddingsCfg: { enabled: false },
  });
  assert.equal(out.retrieval.mode, "full-context");
  assert.match(out.answer, /^LLM saw/);
});

test("runChat: scope=global with embeddings disabled = full-context fallback", async () => {
  const out = await runChat({
    records,
    scope: "global",
    ids: [],
    message: "best?",
    llm: stubLlm,
    embeddingsCfg: { enabled: false },
  });
  assert.equal(out.retrieval.mode, "full-context");
});

test("runChat: scope=global with retriever returns rag mode and only top-K records", async () => {
  let promptedMessages = null;
  const llm = {
    chat: async (msgs) => {
      promptedMessages = msgs;
      return "ok";
    },
  };
  const retriever = {
    topK: async () => [{ recordId: "a-b", score: 0.9, headingPath: null }],
  };
  const out = await runChat({
    records,
    scope: "global",
    ids: [],
    message: "best?",
    llm,
    retriever,
    embeddingsCfg: { enabled: true, retrieval: { topK: 8, minScore: 0 } },
  });
  assert.equal(out.retrieval.mode, "rag");
  assert.equal(out.retrieval.hits.length, 1);
  const stuffed =
    promptedMessages.find((m) => m.role === "user").content +
    promptedMessages.find((m) => m.role === "system").content;
  assert.ok(stuffed.includes("a/b"));
  assert.ok(!stuffed.includes("c/d"));
});

test("runChat: falls back when retriever returns nothing", async () => {
  const retriever = { topK: async () => [] };
  const out = await runChat({
    records,
    scope: "global",
    ids: [],
    message: "x",
    llm: stubLlm,
    retriever,
    embeddingsCfg: { enabled: true, retrieval: { topK: 8, minScore: 0 } },
  });
  assert.equal(out.retrieval.mode, "full-context");
});

test("runChat: falls back when retriever throws", async () => {
  const retriever = { topK: async () => { throw new Error("boom"); } };
  const out = await runChat({
    records,
    scope: "global",
    ids: [],
    message: "x",
    llm: stubLlm,
    retriever,
    embeddingsCfg: { enabled: true, retrieval: { topK: 8, minScore: 0 } },
    log: { warn: () => {} },
  });
  assert.equal(out.retrieval.mode, "full-context");
});
