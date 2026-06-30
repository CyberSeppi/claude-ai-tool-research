// RAG-focused efficiency-research pipeline — additive run.
//
// Researches ONLY RAG / vector-DB / code-RAG / memory / embedding topics in depth,
// verifies on GitHub, then MERGES into data/raw-records.json (no overwrite).
// Existing records from the main pipeline run are preserved; new RAG records are appended.
//
// Run from repo root:
//   Workflow({ scriptPath: ".claude/skills/efficiency-research/pipeline/rag-pipeline.js" })
// then:  npm run report:augment
//        npm run report:build

export const meta = {
  name: 'rag-research-pipeline',
  description: 'RAG-focused deep dive: vector-DB, code-RAG, memory, and embedding MCP servers / skills / tools. Merges additively into data/raw-records.json.',
  phases: [
    { title: 'Discover', detail: 'parallel research per RAG angle' },
    { title: 'Verify', detail: 'WebFetch each repo, correct stars, drop dead' },
  ],
}

const CATS = 'plugin-skill | mcp-server | token-tool | companion-app'
const USE_CASES =
  'research, development, token-efficiency, brainstorming, automation, docs, debugging, ui-design, rag ' +
  '(reuse these consistently; you MAY mint a new concise lowercase-hyphen tag if none fits — e.g. `rag`, `embeddings`, `vector-db`, `memory`, `code-search`)'

const RECORD_SCHEMA = {
  type: 'object',
  properties: {
    records: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'owner/repo for github tools, or product name for companion-app tools' },
          url: { type: 'string', description: 'canonical homepage' },
          repo_url: { type: ['string', 'null'], description: 'GitHub repo url when distinct from the homepage; null for pure homepage records' },
          category: { type: 'string', enum: ['plugin-skill', 'mcp-server', 'token-tool', 'companion-app'] },
          stars: { type: ['integer', 'null'] },
          stars_display: { type: 'string' },
          description: { type: 'string' },
          efficiency_gain: { type: 'string' },
          sources: { type: 'array', items: { type: 'string' } },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
          use_cases: { type: 'array', items: { type: 'string' } },
        },
        required: ['name', 'url', 'category', 'stars_display', 'description', 'efficiency_gain', 'use_cases'],
      },
    },
  },
  required: ['records'],
}

const slug = (u, n) => {
  const m = String(u || '').toLowerCase().match(/github\.com\/([^/]+)\/([^/#?]+)/)
  return m ? `${m[1]}/${m[2].replace(/\.git$/, '')}` : String(n || '').toLowerCase().trim()
}

// RAG-specific research angles — high weight, deeper per-angle quota.
const RAG_ANGLES = [
  {
    label: 'vector-db-mcp',
    prompt:
      'MCP servers that expose vector databases / semantic search to Claude Code. Cover the major engines: Pinecone, Chroma, Qdrant, Weaviate, Milvus, pgvector, LanceDB, Vespa, Marqo, Typesense, Redis-Vector. Also include any well-starred generic "vector store" MCP servers. Prefer officially-maintained or community-recommended ones.',
  },
  {
    label: 'code-rag-repo-search',
    prompt:
      'Repo-aware / codebase-RAG tools that ground Claude Code in large codebases: semantic code search, AST-aware indexing, monorepo retrieval. Examples: Sourcegraph Cody, sweep, aider (rag/code-index parts), continue.dev, repomix-style packers with retrieval, embedchain code, codium-ai cover-agent, claude-code-indexer projects. Find the actual GitHub repos that ship MCP servers OR Claude Code skills/plugins for code-RAG.',
  },
  {
    label: 'memory-knowledge-graph',
    prompt:
      'Persistent-memory / knowledge-graph MCP servers and skills for long-running RAG-style recall across Claude sessions: mem0, letta (formerly MemGPT), graphiti, zep, cognee, memos, neo4j MCP, memory-bank style repos. Also include the official anthropic memory tool / reference MCPs if relevant.',
  },
  {
    label: 'embedding-retrieval-libs',
    prompt:
      'Embedding / retrieval libraries and skills that act as token-efficient context-grounding tools for Claude Code: llamaindex, langchain retrievers wrapped as MCP, haystack, ragflow, R2R (sciphi), verba, dify-rag, kotaemon, anything-LLM, danswer/onyx, khoj, privategpt. Prefer those with an MCP server OR a Claude Code skill/plugin. Star count must be from GitHub.',
  },
  {
    label: 'document-loaders-parsers',
    prompt:
      'Document-parsing / PDF / file-loader MCP servers and skills that feed RAG pipelines used with Claude Code: unstructured-io, markitdown (microsoft), pdfplumber-mcp, docling (IBM), tika MCP wrappers, llama-parse, marker, MinerU. These reduce hallucinations by giving Claude clean structured text to retrieve over.',
  },
  {
    label: 'rag-frameworks-evals',
    prompt:
      'Higher-level RAG frameworks and evaluation toolkits whose GitHub repos can be plugged into Claude Code workflows (as MCP servers, skills, or library deps): ragas, trulens, deepeval, llama_index evals, autogen-rag, openrag, fastrag, txtai, vectara/vectara-cli MCP. Confirm each has a real GitHub repo and read its star count.',
  },
]

// ── Discover ────────────────────────────────────────────────────────────────
phase('Discover')
const discovered = (await parallel(RAG_ANGLES.map((a, i) => () =>
  agent(
    `Deep research angle (RAG focus, weight 5/5): ${a.prompt}\n\n` +
    `Find 10-15 real GitHub repos. For EACH:\n` +
    `- WebFetch the GitHub page to VERIFY it exists and read the CURRENT star count.\n` +
    `- Set stars (integer) + stars_display (e.g. "~12k", "3.4k", "n/a").\n` +
    `- Choose category from ${CATS}. RAG/vector/code-search/memory typically map to "mcp-server" or "token-tool".\n` +
    `- Write a concise one-sentence description and a one-line efficiency_gain (how it boosts Claude Code).\n` +
    `- sources = the URLs you used (the GitHub URL + any docs/MCP-registry URL).\n` +
    `- confidence reflects certainty.\n` +
    `- use_cases = NON-EMPTY array. Always include "rag" as one tag for these records, plus any other from: ${USE_CASES}.\n` +
    `Only include REAL, existing repos. name = owner/repo, url = the https GitHub URL.\n` +
    `Drop forks/abandoned repos with <50 stars unless they are the canonical MCP server for a named product.`,
    { label: `rag-discover:${a.label}`, phase: 'Discover', schema: RECORD_SCHEMA, model: 'sonnet', agentType: 'general-purpose' }
  )
))).filter(Boolean).flatMap((x) => x.records || [])

const seen = new Map()
for (const r of discovered) {
  const k = slug(r.url, r.name)
  if (!k) continue
  if (!seen.has(k)) seen.set(k, r)
}
const unique = [...seen.values()]
log(`RAG discovered ${unique.length} unique repos across ${RAG_ANGLES.length} angles`)

// ── Verify ──────────────────────────────────────────────────────────────────
phase('Verify')
const CHUNK = 8
const chunks = []
for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK))
const verified = (await parallel(chunks.map((batch, i) => () =>
  agent(
    `Verify these candidate RAG repos. For EACH: WebFetch its GitHub page; confirm it EXISTS (not 404/renamed); read the CURRENT star count and correct stars + stars_display; fix category only if clearly wrong (${CATS}); DROP any that do not exist or you cannot verify.\n` +
    `KEEP every other field UNCHANGED — especially the use_cases array (do not alter, reorder, or drop it).\n` +
    `Return ONLY the surviving, corrected records.\n\nCANDIDATES:\n${JSON.stringify(batch)}`,
    { label: `rag-verify:${i}`, phase: 'Verify', schema: RECORD_SCHEMA, model: 'sonnet', agentType: 'general-purpose' }
  )
))).filter(Boolean).flatMap((x) => x.records || [])

const verifiedMap = new Map()
for (const r of verified) {
  const k = slug(r.url, r.name)
  if (k && !verifiedMap.has(k)) verifiedMap.set(k, { ...r, name: k })
}
const newRecords = [...verifiedMap.values()]
log(`RAG verified ${newRecords.length} repos (dropped ${unique.length - newRecords.length})`)

// Return verified records directly — the parent (main loop) merges them into
// data/raw-records.json with a tiny Python script. Avoids the write-raw-records
// agent stall pattern we hit on the main pipeline.
return { discovered: unique.length, verified: newRecords.length, records: newRecords }
