import type { Rec, ChatScope, EnrichedRecord } from "./types";

export class ApiError extends Error {
  status: number;
  body: Record<string, unknown>;
  constructor(status: number, body: Record<string, unknown>) {
    super(`${status} ${JSON.stringify(body)}`);
    this.status = status;
    this.body = body;
  }
}

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new ApiError(res.status, body);
  return body as T;
}

export const api = {
  getRecords: () =>
    jsonFetch<{ generated_at: string | null; records: Rec[] }>("/api/records"),
  refresh: () =>
    jsonFetch<{ generated_at: string | null; count: number }>("/api/refresh", {
      method: "POST",
    }),
  setFlag: (id: string, patch: { interesting?: boolean; note?: string }) =>
    jsonFetch(`/api/records/${encodeURIComponent(id)}/flag`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  chat: (scope: ChatScope, ids: string[], message: string) =>
    jsonFetch<{ answer?: string; error?: string; retrieval?: unknown }>("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, ids, message }),
    }),
  enrichTool: (payload: { url: string; name?: string }) =>
    jsonFetch<{ enriched: EnrichedRecord }>("/api/seeds/enrich", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  addTool: (payload: Partial<EnrichedRecord> & { url: string; name: string; category: Rec["category"] }) =>
    jsonFetch<{ seed: Rec }>("/api/seeds", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }),
  updateTool: (slug: string, patch: Partial<EnrichedRecord>) =>
    jsonFetch<{ seed: Rec }>(`/api/seeds/${encodeURIComponent(slug)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(patch),
    }),
  deleteTool: (slug: string) =>
    jsonFetch<{ deleted: true }>(`/api/seeds/${encodeURIComponent(slug)}`, {
      method: "DELETE",
    }),
};
