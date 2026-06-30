// Efficiency-research pipeline — the full, repeatable research cycle as one Workflow.
//
// Run from the repository root with the Workflow tool:
//   Workflow({ scriptPath: ".claude/skills/efficiency-research/pipeline/research-pipeline.js" })
// then:  npm run report:augment    (GitHub REST: fills in version + contributors)
//        npm run report:build      (dedupes, validates, writes report.json/report.md)
//
// It is driven by research-topics.yaml (the control surface) and writes data/raw-records.json.
// Paths are relative to the repo root (the project cwd the workflow agents run in).

export const meta = {
  name: 'efficiency-research-pipeline',
  description: 'Full efficiency-research cycle: read research-topics.yaml, discover repos per topic (with use_cases), dedupe, verify stars on GitHub, write data/raw-records.json',
  phases: [
    { title: 'Topics', detail: 'read research-topics.yaml' },
    { title: 'Discover', detail: 'parallel research per topic (assigns use_cases)' },
    { title: 'Verify', detail: 'WebFetch each repo, correct stars, drop dead' },
    { title: 'Write', detail: 'dedupe + write data/raw-records.json' },
  ],
}

const CATS = 'plugin-skill | mcp-server | token-tool | companion-app'
const USE_CASES =
  'research, development, token-efficiency, brainstorming, automation, docs, debugging, ui-design ' +
  '(reuse these consistently; you MAY mint a new concise lowercase-hyphen tag if none fits)'

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
          repo_url: { type: ['string', 'null'], description: 'GitHub repo url when distinct from the homepage; null for pure homepage records (build-time falls back to url when url IS github)' },
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

const TOPICS_SCHEMA = {
  type: 'object',
  properties: {
    topics: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          category: { type: 'string' },
          weight: { type: 'integer' },
        },
        required: ['topic'],
      },
    },
  },
  required: ['topics'],
}

const slug = (u, n) => {
  const m = String(u || '').toLowerCase().match(/github\.com\/([^/]+)\/([^/#?]+)/)
  return m ? `${m[1]}/${m[2].replace(/\.git$/, '')}` : String(n || '').toLowerCase().trim()
}

// ── Topics ────────────────────────────────────────────────────────────────
phase('Topics')
const topicsRes = await agent(
  `Read the file research-topics.yaml at the repository root with the Read tool and return its topics as structured data: an array of { topic, category, weight }. ` +
  `If the file is missing or unreadable, return a sensible default set of 6-8 topics covering ${CATS}.`,
  { label: 'load-topics', phase: 'Topics', schema: TOPICS_SCHEMA, model: 'sonnet', agentType: 'general-purpose' }
)
const topics = topicsRes?.topics?.length
  ? topicsRes.topics
  : [{ topic: 'Best Claude Code plugins, skills, and MCP servers for efficiency', category: '', weight: 5 }]
log(`loaded ${topics.length} topics`)

// ── Discover ──────────────────────────────────────────────────────────────
phase('Discover')
const found = (await parallel(topics.map((t, i) => () =>
  agent(
    `Research angle: "${t.topic}" (suggested category: ${t.category || 'any of ' + CATS}, weight ${t.weight ?? 3}/5).\n` +
    `Find the best, coolest, most-efficient GitHub repositories for this that boost Claude Code efficiency for software development and brainstorming. Return ${(t.weight ?? 3) >= 4 ? '10-15' : '5-8'} repos.\n` +
    `For EACH: WebFetch its GitHub page to VERIFY it exists and read the REAL current star count; set stars (integer) + stars_display (e.g. "~58k", "6.7k", "n/a"). Choose category from ${CATS}. Write a concise one-sentence description and a one-line efficiency_gain. sources = the URLs you used. confidence reflects certainty. use_cases = a NON-EMPTY array of 1+ tags from: ${USE_CASES}.\n` +
    `Only include REAL, existing repos. For pure-GitHub tools: name = owner/repo, url = the https GitHub URL, repo_url = same as url (or leave null and the build step will fall back).\n` +
    `For companion-app entries (tools that aren't primarily a GitHub repo — Obsidian, LM Studio, …): name = product name, url = canonical homepage (obsidian.md, lmstudio.ai, …); optionally fill repo_url if a meaningful GitHub presence exists (releases repo, plugin-list repo).\n` +
    `STRICT free-cost gate (applies to ALL categories, but especially companion-app): only include tools that are EITHER\n` +
    `  (a) open-source under an OSI-approved licence (MIT, Apache, GPL, MPL, BSD, …), OR\n` +
    `  (b) unconditionally free for personal use with no completion/token/seat quota (e.g. Obsidian, LM Studio, Jan.ai).\n` +
    `DROP "freemium" tools that gate AI features behind a paid tier or a monthly request quota — Cursor (2000 completions/month), Tabnine free, Codeium free, GitHub Copilot, JetBrains AI Assistant, Windsurf paid tier, etc. all FAIL the gate even though their marketing page calls them "free". When in doubt, drop.`,
    { label: `discover:${i}`, phase: 'Discover', schema: RECORD_SCHEMA, model: 'sonnet', agentType: 'general-purpose' }
  )
))).filter(Boolean).flatMap((x) => x.records || [])

const seen = new Map()
for (const r of found) {
  const k = slug(r.url, r.name)
  if (k && !seen.has(k)) seen.set(k, r)
}
const unique = [...seen.values()]
log(`discovered ${unique.length} unique repos`)

// ── Verify ────────────────────────────────────────────────────────────────
phase('Verify')
const CHUNK = 8
const chunks = []
for (let i = 0; i < unique.length; i += CHUNK) chunks.push(unique.slice(i, i + CHUNK))
const verified = (await parallel(chunks.map((batch, i) => () =>
  agent(
    `Verify these candidate repos. For EACH:\n` +
    `- If url is https://github.com/... → WebFetch the repo page; confirm it EXISTS (not 404/renamed); read the CURRENT star count and correct stars + stars_display.\n` +
    `- If url is a non-github homepage (companion-app) → WebFetch the homepage and confirm: (1) product page is live, (2) free tier or open-source claim is EXPLICIT on the page, (3) claimed capability matches the description. Drop entries that are paywalled with no free tier.\n` +
    `Fix category only if clearly wrong (${CATS}); DROP any that do not exist or you cannot verify.\n` +
    `KEEP every other field UNCHANGED — especially the use_cases array and repo_url (do not alter, reorder, or drop them).\n` +
    `Return ONLY the surviving, corrected records.\n\nCANDIDATES:\n${JSON.stringify(batch)}`,
    { label: `verify:${i}`, phase: 'Verify', schema: RECORD_SCHEMA, model: 'sonnet', agentType: 'general-purpose' }
  )
))).filter(Boolean).flatMap((x) => x.records || [])

const finalMap = new Map()
for (const r of verified) {
  const k = slug(r.url, r.name)
  if (k && !finalMap.has(k)) finalMap.set(k, { ...r, name: k })
}
const finalRecords = [...finalMap.values()].sort((a, b) => (b.stars || 0) - (a.stars || 0))
log(`verified ${finalRecords.length} repos (dropped ${unique.length - finalRecords.length})`)

// ── Write ─────────────────────────────────────────────────────────────────
phase('Write')
const payload = JSON.stringify(finalRecords, null, 2)
const summary = await agent(
  `Use the Write tool to overwrite the file data/raw-records.json at the repository root with the following JSON array VERBATIM (do not modify, add, or remove any content). After writing, reply with the total record count and a per-category tally.\n\nJSON:\n${payload}`,
  { label: 'write-raw-records', phase: 'Write', model: 'sonnet', agentType: 'general-purpose' }
)

return { discovered: unique.length, written: finalRecords.length, summary }
