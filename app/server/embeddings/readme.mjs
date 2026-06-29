// GitHub README fetcher + markdown-aware splitter.
//
// fetchReadme is best-effort: any failure (404, 401, rate-limit, network)
// returns null and the caller falls back to just the fields chunk.
//
// splitMarkdown splits on ## / ### headings. Sections over maxChars get
// char-split with overlap. Each emitted chunk's text starts with a
// `repo/slug: Heading > Sub > Subsub` prefix line so lexical hits on the
// repo name still surface deep README sections.
const OVERLAP = 200;

export async function fetchReadme({ repoSlug, githubToken, fetchImpl = fetch }) {
  if (!repoSlug || !githubToken) return null;
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repoSlug}/readme`, {
      headers: {
        "Authorization": `Bearer ${githubToken}`,
        "Accept": "application/vnd.github.raw",
        "User-Agent": "claude-ai-tool-research",
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export function splitMarkdown(markdown, repoSlug, maxChars) {
  if (!markdown || markdown.trim() === "") return [];
  const lines = markdown.split("\n");
  let h1 = null;
  let h2 = null;
  let h3 = null;
  const sections = [];

  const startSection = (path) => sections.push({ path, body: [] });
  startSection([]); // preamble until first heading

  for (const line of lines) {
    const m1 = /^#\s+(.*)$/.exec(line);
    const m2 = /^##\s+(.*)$/.exec(line);
    const m3 = /^###\s+(.*)$/.exec(line);
    if (m1) {
      h1 = m1[1].trim();
      h2 = null;
      h3 = null;
      startSection([h1]);
    } else if (m2) {
      h2 = m2[1].trim();
      h3 = null;
      startSection([h1 ?? repoSlug, h2]);
    } else if (m3) {
      h3 = m3[1].trim();
      startSection([h1 ?? repoSlug, h2 ?? "(intro)", h3]);
    } else {
      sections[sections.length - 1].body.push(line);
    }
  }

  const filled = sections
    .map((s) => ({
      path: s.path.length ? s.path : [h1 ?? repoSlug],
      body: s.body.join("\n").trim(),
    }))
    .filter((s) => s.body.length > 0);

  if (filled.length === 0) {
    // No headings at all — the entire body is one chunk and the heading
    // path is just the repo slug (no "slug: heading" prefix needed).
    return [{ headingPath: repoSlug, text: `${repoSlug}\n\n${markdown.trim()}` }];
  }

  const chunks = [];
  for (const s of filled) {
    // When the only "heading" we have is the repo slug (preamble of a
    // headingless README), emit just the slug — avoid the "o/r: o/r"
    // double prefix.
    const headingPath =
      s.path.length === 1 && s.path[0] === repoSlug
        ? repoSlug
        : `${repoSlug}: ${s.path.join(" > ")}`;
    const fullText = `${headingPath}\n\n${s.body}`;
    if (fullText.length <= maxChars) {
      chunks.push({ headingPath, text: fullText });
    } else {
      let i = 0;
      const body = s.body;
      while (i < body.length) {
        const slice = body.slice(i, i + maxChars);
        chunks.push({ headingPath, text: `${headingPath}\n\n${slice}` });
        if (i + maxChars >= body.length) break;
        i += maxChars - OVERLAP;
      }
    }
  }
  return chunks;
}
