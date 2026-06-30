function recordDetail(r) {
  const meta = [
    `${r.stars_display ?? "?"} stars`,
    r.version ? `version ${r.version}` : null,
    r.contributors != null ? `${r.contributors} contributors` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return [
    `### ${r.name} (${r.category}) — ${meta}`,
    `URL: ${r.url}`,
    `What it does: ${r.description}`,
    `Efficiency gain: ${r.efficiency_gain}`,
  ].join("\n");
}

function recordLine(r) {
  return `- ${r.name} [${r.category}, ${r.stars_display ?? "?"}★${r.version ? `, ${r.version}` : ""}]: ${r.description}`;
}

const SYSTEM =
  "You are a concise, helpful research assistant. Answer only from the provided context.";

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
  return `Here is the full set of researched repositories. Compare and rate them against each other for the user's goal (boosting Claude Code efficiency for dev work and brainstorming). When asked, rank them and justify.\n\n${records.map(recordLine).join("\n")}`;
}

// Orchestrator. Picks RAG when (a) scope=global, (b) embeddings enabled,
// (c) a retriever is wired AND returns at least one hit. Otherwise falls
// back to the legacy stuffing path. Errors in retrieval are non-fatal —
// we degrade to full-context.
export async function runChat({
  records,
  scope,
  ids = [],
  message,
  llm,
  retriever,
  embeddingsCfg,
  log = console,
}) {
  let context;
  let retrieval = { mode: "full-context" };

  if (scope === "global" && embeddingsCfg?.enabled && retriever) {
    try {
      const hits = await retriever.topK(message);
      if (hits.length > 0) {
        const byId = new Map(records.map((r) => [r.id, r]));
        const picked = hits.map((h) => byId.get(h.recordId)).filter(Boolean);
        if (picked.length > 0) {
          context = `Here are the repositories that best match the user's question. Compare and rank them; cite by name.\n\n${picked
            .map(recordDetail)
            .join("\n\n")}`;
          retrieval = { mode: "rag", topK: hits.length, hits };
        }
      }
    } catch (err) {
      log.warn?.(`[chat] retriever failed, falling back: ${err.message}`);
    }
  }
  if (!context) context = buildChatContext(records, scope, ids);

  const messages = [
    { role: "system", content: SYSTEM },
    { role: "user", content: `${context}\n\n---\nUser question: ${message}` },
  ];
  const answer = await llm.chat(messages);
  return { answer, retrieval };
}
