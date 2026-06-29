import { useEffect, useMemo, useState } from "react";
import {
  flexRender, getCoreRowModel, getSortedRowModel,
  useReactTable, type SortingState,
} from "@tanstack/react-table";
import { api } from "./api";
import type { Rec } from "./types";
import { columns } from "./columns";
import { matchesQuery } from "./filters";
import { DetailPanel } from "./DetailPanel";
import { ChatBox } from "./ChatBox";
import { useResizable } from "./useResizable";

export function App() {
  const [records, setRecords] = useState<Rec[]>([]);
  const [generatedAt, setGeneratedAt] = useState<string | null>(null);
  const [globalFilter, setGlobalFilter] = useState("");
  const [category, setCategory] = useState("");
  const [useCase, setUseCase] = useState("");
  const [sorting, setSorting] = useState<SortingState>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [chatOpen, setChatOpen] = useState(false);
  const chatResize = useResizable();

  const toggle = (id: string) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const load = async () => {
    const { records, generated_at } = await api.getRecords();
    setRecords(records);
    setGeneratedAt(generated_at);
  };
  useEffect(() => { load(); }, []);

  const onFlag = async (id: string, interesting: boolean) => {
    await api.setFlag(id, { interesting });
    setRecords((rs) => rs.map((r) => (r.id === id ? { ...r, flagged: interesting } : r)));
  };

  const flagSelected = async () => {
    const ids = [...selected];
    await Promise.all(ids.map((id) => api.setFlag(id, { interesting: true })));
    setRecords((rs) => rs.map((r) => (selected.has(r.id) ? { ...r, flagged: true } : r)));
  };

  const useCaseOptions = useMemo(
    () => [...new Set(records.flatMap((r) => r.use_cases ?? []))].sort(),
    [records]
  );

  const data = useMemo(
    () => records.filter((r) =>
      (category ? r.category === category : true) &&
      (useCase ? (r.use_cases ?? []).includes(useCase) : true) &&
      matchesQuery(r, globalFilter)
    ),
    [records, category, useCase, globalFilter]
  );

  const table = useReactTable({
    data,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    meta: { selected, toggle, onFlag },
  });

  return (
    <div className="min-h-screen bg-void text-primary p-6">

      {/* ── Header ── */}
      <header className="flex items-baseline justify-between border-b border-edge pb-4">
        <h1 className="font-mono text-lg font-light tracking-[0.25em] uppercase text-primary">
          Claude Efficiency Research
        </h1>
        <span className="font-mono text-[11px] text-muted tabular-nums">
          {data.length}/{records.length} · {generatedAt ?? "—"}
        </span>
      </header>

      {/* ── Controls ── */}
      <div className="mt-4 flex gap-2">
        <input
          value={globalFilter}
          onChange={(e) => setGlobalFilter(e.target.value)}
          placeholder="Search name, description, category…"
          className="w-80 rounded bg-raised border border-edge px-3 py-1.5 text-sm text-primary placeholder:text-dim focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
        />
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="rounded bg-raised border border-edge px-2 py-1.5 text-sm text-primary focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
        >
          <option value="">All categories</option>
          <option value="plugin-skill">plugin-skill</option>
          <option value="mcp-server">mcp-server</option>
          <option value="token-tool">token-tool</option>
        </select>
        <select
          value={useCase}
          onChange={(e) => setUseCase(e.target.value)}
          className="rounded bg-raised border border-edge px-2 py-1.5 text-sm text-primary focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent"
        >
          <option value="">All use-cases</option>
          {useCaseOptions.map((u) => (
            <option key={u} value={u}>{u}</option>
          ))}
        </select>
        <button
          onClick={async () => { await api.refresh(); await load(); }}
          className="rounded bg-accent px-3 py-1.5 font-mono text-xs font-medium tracking-wide text-black hover:bg-accent-bright transition-colors"
        >
          Refresh
        </button>
        {selected.size > 0 && (
          <button
            onClick={flagSelected}
            className="rounded border border-accent px-3 py-1.5 font-mono text-xs font-medium tracking-wide text-accent hover:bg-accent hover:text-black transition-colors"
            title="Flag all selected records as interesting"
          >
            ★ Flag {selected.size} selected
          </button>
        )}
      </div>

      {/* ── Table ── */}
      <table className="mt-5 w-full text-sm border-collapse">
        <thead>
          {table.getHeaderGroups().map((hg) => (
            <tr key={hg.id} className="border-b border-edge">
              {hg.headers.map((h) => (
                <th
                  key={h.id}
                  className="py-2 pr-4 cursor-pointer select-none font-mono text-[11px] tracking-widest uppercase text-muted text-left"
                  onClick={h.column.getToggleSortingHandler()}
                >
                  {flexRender(h.column.columnDef.header, h.getContext())}
                  {{ asc: " ▲", desc: " ▼" }[h.column.getIsSorted() as string] ?? ""}
                </th>
              ))}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="py-12 text-center font-mono text-xs tracking-widest text-dim">
                NO RECORDS MATCH
              </td>
            </tr>
          ) : (
            table.getRowModel().rows.map((row) => (
              <tr
                key={row.id}
                className={`border-b border-edge cursor-pointer transition-colors
                  ${selected.has(row.original.id)
                    ? "bg-accent/[0.07]"
                    : "hover:bg-raised"
                  }`}
                onClick={() => { setSelectedId(row.original.id); setChatOpen(false); }}
              >
                {row.getVisibleCells().map((cell) => (
                  <td key={cell.id} className="py-2 pr-4 align-top max-w-md text-primary">
                    {flexRender(cell.column.columnDef.cell, cell.getContext())}
                  </td>
                ))}
              </tr>
            ))
          )}
        </tbody>
      </table>

      {/* ── Floating chat trigger ── */}
      {!chatOpen && (
        <button
          onClick={() => { setChatOpen(true); setSelectedId(null); }}
          className="fixed bottom-6 right-6 z-40 grid h-14 w-14 place-items-center rounded-full bg-accent text-black shadow-lg shadow-black/40 hover:bg-accent-bright transition-colors"
          title={selected.size > 0 ? `Compare ${selected.size} selected` : "Ask across all records"}
          aria-label="Open chat across records"
        >
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
          </svg>
          {selected.size > 0 && (
            <span className="absolute -right-1 -top-1 grid h-5 min-w-5 place-items-center rounded-full border border-accent bg-void px-1 font-mono text-[10px] text-accent">
              {selected.size}
            </span>
          )}
        </button>
      )}

      {/* ── Chat side panel ── */}
      {chatOpen && (
        <aside style={{ width: chatResize.width }} className="fixed right-0 top-0 z-30 h-full overflow-y-auto bg-surface border-l border-edge p-5">
          <div
            onPointerDown={chatResize.onPointerDown}
            className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-accent/40"
            title="Drag to resize"
            aria-label="Resize panel"
          />
          <div className="flex items-start justify-between">
            <h2 className="font-mono text-sm tracking-widest uppercase text-muted">
              {selected.size > 0 ? `Compare ${selected.size} selected` : "Ask across all records"}
            </h2>
            <button onClick={() => setChatOpen(false)} className="font-mono text-muted hover:text-primary px-1" aria-label="Close chat">✕</button>
          </div>
          <ChatBox
            scope={selected.size > 0 ? "selection" : "global"}
            ids={[...selected]}
            title={selected.size > 0 ? "Compare & rate the selected repos" : "Compare, rank, or ask about all repos"}
          />
        </aside>
      )}

      {/* ── Detail Panel ── */}
      {selectedId && (() => {
        const rec = records.find((r) => r.id === selectedId);
        return rec ? <DetailPanel record={rec} onFlag={onFlag} onClose={() => setSelectedId(null)} /> : null;
      })()}
    </div>
  );
}
