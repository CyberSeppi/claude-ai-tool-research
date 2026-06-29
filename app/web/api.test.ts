import { test, expect, vi } from "vitest";
import { api } from "./api";

test("getRecords returns records array", async () => {
  globalThis.fetch = vi.fn(async () =>
    new Response(JSON.stringify({ generated_at: "t", records: [{ id: "a-b" }] }), {
      status: 200, headers: { "content-type": "application/json" },
    })
  ) as any;
  const out = await api.getRecords();
  expect(out.records.length).toBe(1);
  expect(out.records[0].id).toBe("a-b");
});

test("setFlag POSTs to the right url", async () => {
  const spy = vi.fn(async () => new Response(JSON.stringify({ id: "a-b", flag: { interesting: true } }), { status: 200 }));
  globalThis.fetch = spy as any;
  await api.setFlag("a-b", { interesting: true });
  expect(spy).toHaveBeenCalledWith("/api/records/a-b/flag", expect.objectContaining({ method: "POST" }));
});
