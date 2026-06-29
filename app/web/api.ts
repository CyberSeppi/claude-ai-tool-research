import type { Rec, ChatScope } from "./types";

async function jsonFetch(url: string, init?: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${url} -> ${res.status}`);
  return res.json();
}

export const api = {
  getRecords: (): Promise<{ generated_at: string | null; records: Rec[] }> =>
    jsonFetch("/api/records"),
  refresh: (): Promise<{ generated_at: string | null; count: number }> =>
    jsonFetch("/api/refresh", { method: "POST" }),
  setFlag: (id: string, patch: { interesting?: boolean; note?: string }) =>
    jsonFetch(`/api/records/${encodeURIComponent(id)}/flag`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  chat: (scope: ChatScope, ids: string[], message: string): Promise<{ answer?: string; error?: string }> =>
    jsonFetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, ids, message }),
    }),
};
