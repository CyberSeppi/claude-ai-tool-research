import { readFile as _readFile, writeFile as _writeFile, mkdir } from "node:fs/promises";
import { join as _join } from "node:path";
import { slugOf, repoName, scanInstalled } from "./scan-installed.mjs";

const norm = (s) => String(s).toLowerCase().replace(/\.git$/, "").trim();

const CATEGORIES = ["plugin-skill", "mcp-server", "token-tool"];
const CATEGORY_TITLES = {
  "plugin-skill": "Plugins & Skills",
  "mcp-server": "MCP Servers",
  "token-tool": "Token & Research Tools",
};

export function idOf(record) {
  const base = (record.url && slugOf(record.url)) || record.name || "";
  return norm(base).replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
}

export function matchInstalled(record, scan) {
  const name = repoName(record.url || record.name || "");
  const slug = slugOf(record.url || "");
  const byName = (arr) => arr.find((e) => norm(e.name) === name);
  const plugin = byName(scan.plugins);
  if (plugin) return { installed: true, installed_path: plugin.path, installed_via: `plugin:${plugin.marketplace}` };
  const skill = byName(scan.skills);
  if (skill) return { installed: true, installed_path: skill.path, installed_via: "skill" };
  const mcp = byName(scan.mcpServers);
  if (mcp) return { installed: true, installed_path: mcp.source, installed_via: "mcp" };
  const marketplace = (scan.marketplaces ?? []).find(
    (m) => norm(m.name) === name || (slug && m.repo && norm(m.repo) === slug),
  );
  if (marketplace) return { installed: true, installed_path: marketplace.path ?? null, installed_via: "marketplace" };
  if (slug && scan.installedSlugs.includes(slug)) return { installed: true, installed_path: null, installed_via: "marketplace" };
  return { installed: false, installed_path: null, installed_via: null };
}

export function buildReport(rawRecords, scan, { generatedAt, date, query = "" }) {
  const seen = new Set();
  const records = [];
  for (const r of rawRecords) {
    if (!CATEGORIES.includes(r.category)) throw new Error(`bad category: ${r.category}`);
    const id = idOf(r);
    if (seen.has(id)) continue;
    seen.add(id);
    const inst = matchInstalled(r, scan);
    records.push({
      id,
      name: r.name,
      url: r.url,
      category: r.category,
      stars: r.stars ?? null,
      stars_display: r.stars_display ?? null,
      description: r.description ?? "",
      efficiency_gain: r.efficiency_gain ?? "",
      installed: inst.installed,
      installed_path: inst.installed_path,
      installed_via: inst.installed_via,
      sources: r.sources ?? [],
      confidence: r.confidence ?? "medium",
      use_cases: Array.isArray(r.use_cases) ? r.use_cases : [],
      last_researched: date,
    });
  }
  return { generated_at: generatedAt, query, records };
}

export function validateReport(report) {
  if (!report || typeof report !== "object") throw new Error("report not an object");
  if (!report.generated_at) throw new Error("missing generated_at");
  if (!Array.isArray(report.records)) throw new Error("records not an array");
  for (const r of report.records) {
    for (const f of ["id", "name", "url", "category"]) {
      if (!r[f]) throw new Error(`record missing ${f}: ${JSON.stringify(r).slice(0, 80)}`);
    }
    if (!CATEGORIES.includes(r.category)) throw new Error(`bad category: ${r.category}`);
  }
  return true;
}

export function renderMarkdown(report) {
  const lines = [];
  lines.push("# Claude Efficiency Repos — Research Report", "");
  lines.push(`> Generated: ${report.generated_at}. Star counts are time-sensitive snapshots.`, "");
  for (const cat of CATEGORIES) {
    const rows = report.records.filter((r) => r.category === cat);
    if (!rows.length) continue;
    lines.push(`## ${CATEGORY_TITLES[cat]}`, "");
    lines.push("| Repo | Stars | Installed | Description |", "|---|---|---|---|");
    for (const r of rows) {
      const mark = r.installed ? "✓" : "—";
      lines.push(`| [${r.name}](${r.url}) | ${r.stars_display ?? "?"} | ${mark} | ${r.description} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export async function run({ rawRecordsPath, outDir, home, cwd, now = new Date(), query = "" }) {
  const raw = JSON.parse(await _readFile(rawRecordsPath, "utf8"));
  const scan = await scanInstalled({ home, cwd });
  const date = now.toISOString().slice(0, 10);
  const report = buildReport(raw, scan, { generatedAt: now.toISOString(), date, query });
  validateReport(report);
  await mkdir(outDir, { recursive: true });
  const jsonPath = _join(outDir, "report.json");
  const mdPath = _join(outDir, "report.md");
  await _writeFile(jsonPath, JSON.stringify(report, null, 2) + "\n");
  await _writeFile(mdPath, renderMarkdown(report) + "\n");
  return { report, jsonPath, mdPath };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const rawRecordsPath = process.argv[2] ?? "data/raw-records.json";
  const outDir = process.argv[3] ?? "data";
  run({ rawRecordsPath, outDir })
    .then((r) => console.log(`Wrote ${r.report.records.length} records -> ${r.jsonPath}, ${r.mdPath}`))
    .catch((err) => {
      console.error(err?.stack ?? err);
      process.exit(1);
    });
}
