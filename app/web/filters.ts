import type { Rec } from "./types";

export function matchesQuery(r: Pick<Rec, "name" | "description" | "category" | "efficiency_gain">, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [r.name, r.description, r.category, r.efficiency_gain]
    .join(" ")
    .toLowerCase()
    .includes(needle);
}
