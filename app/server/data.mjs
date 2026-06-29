import { readFileSync } from "node:fs";
import { join } from "node:path";

export function loadReport(dataDir) {
  try {
    const raw = readFileSync(join(dataDir, "report.json"), "utf8");
    const j = JSON.parse(raw);
    return {
      generated_at: j.generated_at ?? null,
      query: j.query ?? "",
      records: Array.isArray(j.records) ? j.records : [],
    };
  } catch {
    return { generated_at: null, query: "", records: [] };
  }
}
