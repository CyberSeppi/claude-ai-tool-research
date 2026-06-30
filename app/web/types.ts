export interface Rec {
  id: string;
  name: string;
  url: string;
  repo_url: string | null;
  category: "plugin-skill" | "mcp-server" | "token-tool" | "companion-app";
  stars: number | null;
  stars_display: string | null;
  version: string | null;
  contributors: number | null;
  description: string;
  efficiency_gain: string;
  sources: string[];
  confidence: string;
  use_cases: string[];
  last_researched: string;
  flagged: boolean;
  note: string;
  curated: boolean;
}

export interface EnrichedRecord {
  name: string;
  url: string;
  repo_url: string | null;
  category: Rec["category"];
  description: string;
  efficiency_gain: string;
  use_cases: string[];
  sources: string[];
  confidence: "high" | "medium" | "low";
  stars: number | null;
  stars_display: string | null;
  version: string | null;
  contributors: number | null;
  free: boolean | null;
  free_check_reason: string | null;
}

export type ChatScope = "record" | "selection" | "global";
