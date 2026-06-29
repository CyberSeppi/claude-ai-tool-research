import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const norm = (s) => String(s).toLowerCase().replace(/\.git$/, "").trim();

export function slugOf(url) {
  const m = norm(url).match(/github\.com[/:]([\w.-]+)\/([\w.-]+)/);
  return m ? `${m[1]}/${m[2]}` : null;
}

export function repoName(urlOrName) {
  const slug = slugOf(urlOrName);
  if (slug) return slug.split("/")[1];
  return norm(urlOrName).split("/").pop();
}

async function listDirs(p) {
  if (!existsSync(p)) return [];
  try {
    const ents = await readdir(p, { withFileTypes: true });
    return ents.filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    return [];
  }
}

function slugsFromText(text) {
  const out = new Set();
  const re = /github\.com[/:]([\w.-]+)\/([\w.-]+)/gi;
  let m;
  while ((m = re.exec(text))) out.add(norm(`${m[1]}/${m[2]}`));
  return [...out];
}

async function addSlugsFromFile(path, set) {
  if (!existsSync(path)) return;
  try {
    slugsFromText(await readFile(path, "utf8")).forEach((s) => set.add(s));
  } catch {}
}

export async function scanInstalled(opts = {}) {
  const home = opts.home ?? homedir();
  const cwd = opts.cwd ?? process.cwd();
  const skills = [];
  const plugins = [];
  const mcpServers = [];
  const marketplaces = [];
  const installedSlugs = new Set();
  const installedNames = new Set();

  for (const root of [join(home, ".claude", "skills"), join(cwd, ".claude", "skills")]) {
    for (const name of await listDirs(root)) {
      skills.push({ name, path: join(root, name) });
      installedNames.add(norm(name));
    }
  }

  const cache = join(home, ".claude", "plugins", "cache");
  for (const market of await listDirs(cache)) {
    for (const plugin of await listDirs(join(cache, market))) {
      const pluginDir = join(cache, market, plugin);
      plugins.push({ name: plugin, path: pluginDir, marketplace: market });
      installedNames.add(norm(plugin));
      // Real layout is cache/<market>/<plugin>/<version>/..., but older/flat
      // layouts keep skills+manifests directly under <plugin>. Handle BOTH:
      // scan the plugin dir itself AND every child (version) dir.
      const scanDirs = [pluginDir, ...(await listDirs(pluginDir)).map((v) => join(pluginDir, v))];
      for (const dir of scanDirs) {
        for (const sk of await listDirs(join(dir, "skills"))) {
          skills.push({ name: sk, path: join(dir, "skills", sk) });
          installedNames.add(norm(sk));
        }
        for (const mf of ["plugin.json", join(".claude-plugin", "plugin.json"), "package.json"]) {
          await addSlugsFromFile(join(dir, mf), installedSlugs);
        }
      }
    }
  }

  for (const f of [join(home, ".claude.json"), join(cwd, ".mcp.json"), join(cwd, ".claude", "settings.json")]) {
    if (!existsSync(f)) continue;
    try {
      const j = JSON.parse(await readFile(f, "utf8"));
      const servers = j.mcpServers ?? j.mcp?.servers ?? {};
      for (const [name, cfg] of Object.entries(servers)) {
        mcpServers.push({ name, source: f });
        installedNames.add(norm(name));
        // Narrow scope: only treat slugs found *inside* an mcpServers config as
        // installed — a stray github URL elsewhere in the file is not a signal.
        slugsFromText(JSON.stringify(cfg)).forEach((s) => installedSlugs.add(s));
      }
    } catch {}
  }

  // Read canonical registry files from ~/.claude/plugins/
  const pluginsDir = join(home, ".claude", "plugins");

  const knownMarketplacesPath = join(pluginsDir, "known_marketplaces.json");
  if (existsSync(knownMarketplacesPath)) {
    try {
      const raw = JSON.parse(await readFile(knownMarketplacesPath, "utf8"));
      for (const [marketName, entry] of Object.entries(raw)) {
        installedNames.add(norm(marketName));
        const repo = entry?.source?.repo;
        if (repo) installedSlugs.add(norm(repo));
        marketplaces.push({
          name: marketName,
          path: entry?.installLocation ?? null,
          repo: repo ? norm(repo) : null,
        });
      }
    } catch {}
  }

  const installedPluginsPath = join(pluginsDir, "installed_plugins.json");
  if (existsSync(installedPluginsPath)) {
    try {
      const raw = JSON.parse(await readFile(installedPluginsPath, "utf8"));
      const pluginMap = raw?.plugins ?? {};
      for (const [key, entries] of Object.entries(pluginMap)) {
        const atIdx = key.lastIndexOf("@");
        const pluginName = atIdx >= 0 ? key.slice(0, atIdx) : key;
        const marketplace = atIdx >= 0 ? key.slice(atIdx + 1) : null;
        const installPath = Array.isArray(entries) && entries[0]?.installPath ? entries[0].installPath : null;
        plugins.push({ name: pluginName, path: installPath, marketplace });
        installedNames.add(norm(pluginName));
      }
    } catch {}
  }

  // Dedupe plugins and skills by normalized name so the same plugin discovered
  // via cache-walk (e.g. .../superpowers) and via the registry (.../6.0.3)
  // collapses to a single entry.
  const deduped = (arr) => {
    const seen = new Set();
    return arr.filter((item) => {
      const key = norm(item.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  };

  return {
    skills: deduped(skills),
    plugins: deduped(plugins),
    mcpServers,
    marketplaces,
    installedSlugs: [...installedSlugs],
    installedNames: [...installedNames],
  };
}
