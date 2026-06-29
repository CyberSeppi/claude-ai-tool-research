// Build the single "fields" chunk per record — name + category +
// use_cases + description + efficiency_gain.
//
// This text gets embedded once per record and serves the simple case
// (no README fetch). When the GitHub fetch succeeds, additional
// readme-chunks are appended; see readme.mjs.
export function buildFieldsChunk(record) {
  const useCases = Array.isArray(record.use_cases) ? record.use_cases.join(", ") : "";
  const head = useCases ? `${record.category} · ${useCases}` : record.category;
  const text = [
    record.name,
    head,
    "",
    record.description ?? "",
    "",
    `Efficiency gain: ${record.efficiency_gain ?? ""}`,
  ].join("\n");
  return { source: "fields", headingPath: null, text };
}
