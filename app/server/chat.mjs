function recordDetail(r) {
  return [
    `### ${r.name} (${r.category}) — ${r.stars_display ?? "?"} stars${r.installed ? ", installed" : ""}`,
    `URL: ${r.url}`,
    `What it does: ${r.description}`,
    `Efficiency gain: ${r.efficiency_gain}`,
  ].join("\n");
}

function recordLine(r) {
  return `- ${r.name} [${r.category}, ${r.stars_display ?? "?"}★${r.installed ? ", installed" : ""}]: ${r.description}`;
}

export function buildChatContext(records, scope, ids = []) {
  const byId = new Map(records.map((r) => [r.id, r]));
  if (scope === "record") {
    const r = byId.get(ids[0]);
    if (!r) return "No record selected.";
    return `You are answering questions about this one repository:\n\n${recordDetail(r)}`;
  }
  if (scope === "selection") {
    const chosen = ids.map((id) => byId.get(id)).filter(Boolean);
    return `Compare and rate these selected repositories against each other for boosting Claude Code efficiency. Be specific about trade-offs and give a recommendation.\n\n${chosen.map(recordDetail).join("\n\n")}`;
  }
  // global
  return `Here is the full set of researched repositories. Compare and rate them against each other for the user's goal (boosting Claude Code efficiency for dev work and brainstorming). When asked, rank them and justify.\n\n${records.map(recordLine).join("\n")}`;
}
