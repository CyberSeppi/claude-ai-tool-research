// Auto-fill helper for the "Add Tool" modal preview step.
//
// Branches on the URL host:
//   github.com/{owner}/{repo} → REST API for stars/version/contributors
//                                 + description + license + topics.
//                                 LLM is NOT called; the modal pre-fills
//                                 efficiency_gain/use_cases from topics
//                                 and the repo description, and the user
//                                 edits them.
//   anything else            → WebFetch homepage HTML + single LLM call
//                                 with a strict JSON schema asking for
//                                 description, efficiency_gain, use_cases,
//                                 category, and a free-tier boolean.
//
// All outbound fetch goes via the global undici dispatcher set in
// index.mjs, so HTTPS_PROXY is respected.
const GITHUB_RE = /^https:\/\/github\.com\/([^/]+)\/([^/?#]+)/i;

export function isGithubUrl(url) {
  if (typeof url !== "string") return false;
  return GITHUB_RE.test(url);
}

function formatStars(n) {
  if (n == null) return null;
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  return `~${Math.round(n / 1000)}k`;
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "claude-ai-tool-research",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchRepoMeta(slug, token, fetchImpl) {
  const r = await fetchImpl(`https://api.github.com/repos/${slug}`, {
    headers: githubHeaders(token),
  });
  if (r.status === 404) throw new Error(`github repo not found: ${slug}`);
  if (!r.ok) throw new Error(`github upstream failed: ${r.status}`);
  return await r.json();
}

async function fetchVersion(slug, token, fetchImpl) {
  try {
    const r = await fetchImpl(`https://api.github.com/repos/${slug}/releases/latest`, {
      headers: githubHeaders(token),
    });
    if (r.ok) {
      const j = await r.json();
      return j.tag_name || j.name || null;
    }
    const t = await fetchImpl(
      `https://api.github.com/repos/${slug}/tags?per_page=1`,
      { headers: githubHeaders(token) },
    );
    if (!t.ok) return null;
    const tags = await t.json();
    return Array.isArray(tags) && tags[0]?.name ? tags[0].name : null;
  } catch {
    return null;
  }
}

async function fetchContributors(slug, token, fetchImpl) {
  try {
    const r = await fetchImpl(
      `https://api.github.com/repos/${slug}/contributors?per_page=1&anon=true`,
      { headers: githubHeaders(token) },
    );
    if (!r.ok) return null;
    const link = r.headers.get("link") || "";
    const m = link.match(/[?&]page=(\d+)>;\s*rel="last"/);
    if (m) return Number.parseInt(m[1], 10);
    const body = await r.json();
    return Array.isArray(body) ? body.length : null;
  } catch {
    return null;
  }
}

const LLM_SYSTEM =
  "You extract structured product metadata from web pages for a research catalogue. " +
  "Reply with valid JSON only — no prose, no markdown fences.";

const LLM_SCHEMA_HINT =
  '{"description": string, "efficiency_gain": string, ' +
  '"use_cases": string[], ' +
  '"category": "plugin-skill" | "mcp-server" | "token-tool" | "companion-app", ' +
  '"free": boolean, "free_check_reason": string}';

function buildLlmPrompt(url, name, html) {
  return [
    {
      role: "system",
      content: LLM_SYSTEM,
    },
    {
      role: "user",
      content:
        `Tool homepage: ${url}\n` +
        (name ? `Suspected name: ${name}\n` : "") +
        `Below is the HTML. Extract metadata that helps a Claude Code user decide whether the tool is worth installing.\n\n` +
        `Required JSON shape: ${LLM_SCHEMA_HINT}\n\n` +
        `Rules:\n` +
        `- description: one sentence, neutral, factual.\n` +
        `- efficiency_gain: one line — how it boosts Claude Code productivity.\n` +
        `- use_cases: 1–5 lowercase-hyphen tags from {research, development, ` +
        `token-efficiency, brainstorming, automation, docs, debugging, ` +
        `ui-design, rag, knowledge-tool, note-taking, local-llm, ai-editor, ` +
        `ai-plugin, memory, free}. You may mint new lowercase-hyphen tags.\n` +
        `- category: best fit from the four enum values.\n` +
        `- free: true ONLY if the homepage explicitly offers a free tier ` +
        `with no AI-feature quota or open-source licence; false otherwise.\n` +
        `- free_check_reason: one phrase quoting evidence from the page.\n\n` +
        `HTML (truncated to 60KB):\n` +
        String(html).slice(0, 60000),
    },
  ];
}

async function fetchHomepageHtml(url, fetchImpl) {
  const r = await fetchImpl(url, {
    headers: { "User-Agent": "claude-ai-tool-research", Accept: "text/html,*/*" },
  });
  if (!r.ok) throw new Error(`homepage fetch failed: ${r.status}`);
  return await r.text();
}

function parseLlmJson(text) {
  // Some models still wrap JSON in ``` fences; strip and try once.
  const cleaned = String(text)
    .trim()
    .replace(/^```(?:json)?\s*/, "")
    .replace(/\s*```$/, "");
  try {
    return JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`enrich: LLM did not return valid JSON: ${err.message}`);
  }
}

export async function enrichFromUrl({
  url,
  name,
  githubToken,
  llm,
  fetchImpl = fetch,
}) {
  if (typeof url !== "string" || !url.trim()) throw new Error("url required");

  if (isGithubUrl(url)) {
    const m = url.match(GITHUB_RE);
    const slug = `${m[1]}/${m[2].replace(/\.git$/, "")}`.toLowerCase();
    const [meta, version, contributors] = await Promise.all([
      fetchRepoMeta(slug, githubToken, fetchImpl),
      fetchVersion(slug, githubToken, fetchImpl),
      fetchContributors(slug, githubToken, fetchImpl),
    ]);
    return {
      name: name || slug,
      url,
      repo_url: url,
      category: "plugin-skill", // default; user adjusts in modal
      description: meta.description || "",
      efficiency_gain: "",
      use_cases: Array.isArray(meta.topics)
        ? meta.topics.filter((t) => typeof t === "string").slice(0, 8)
        : [],
      sources: [url],
      confidence: "high",
      stars: meta.stargazers_count ?? null,
      stars_display: formatStars(meta.stargazers_count),
      version,
      contributors,
      free: null,
      free_check_reason: null,
    };
  }

  if (!llm) throw new Error("enrich: non-github URL requires an LLM client");
  const html = await fetchHomepageHtml(url, fetchImpl);
  const reply = await llm.chat(buildLlmPrompt(url, name, html));
  const parsed = parseLlmJson(reply);
  return {
    name: name || parsed.name || new URL(url).hostname,
    url,
    repo_url: null,
    category: parsed.category ?? "companion-app",
    description: parsed.description ?? "",
    efficiency_gain: parsed.efficiency_gain ?? "",
    use_cases: Array.isArray(parsed.use_cases) ? parsed.use_cases : [],
    sources: [url],
    confidence: "medium",
    stars: null,
    stars_display: null,
    version: null,
    contributors: null,
    free: typeof parsed.free === "boolean" ? parsed.free : null,
    free_check_reason: parsed.free_check_reason ?? null,
  };
}
