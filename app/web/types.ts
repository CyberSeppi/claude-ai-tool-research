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
}
export type ChatScope = "record" | "selection" | "global";
