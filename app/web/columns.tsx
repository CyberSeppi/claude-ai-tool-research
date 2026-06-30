import type { ColumnDef } from "@tanstack/react-table";
import type { Rec } from "./types";
import { GithubIcon, GlobeIcon, isGithubUrl } from "./icons";

export const columns: ColumnDef<Rec>[] = [
  {
    id: "select",
    header: "",
    size: 32,
    cell: (info) => {
      const meta = info.table.options.meta as { selected: Set<string>; toggle: (id: string) => void };
      const id = info.row.original.id;
      return (
        <input
          type="checkbox"
          checked={meta.selected.has(id)}
          onClick={(e) => e.stopPropagation()}
          onChange={() => meta.toggle(id)}
          title="Select for compare"
          aria-label="Select for compare"
        />
      );
    },
  },
  {
    accessorKey: "flagged",
    header: "Flag",
    size: 48,
    cell: (info) => {
      const meta = info.table.options.meta as { onFlag: (id: string, v: boolean) => void };
      const r = info.row.original;
      return (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); meta.onFlag(r.id, !r.flagged); }}
          className={`text-base leading-none transition-colors ${r.flagged ? "text-accent" : "text-dim hover:text-accent"}`}
          title={r.flagged ? "Flagged — click to remove" : "Flag as interesting"}
          aria-label={r.flagged ? "Remove flag" : "Flag as interesting"}
        >
          {r.flagged ? "★" : "☆"}
        </button>
      );
    },
  },
  {
    accessorKey: "name",
    header: "Name",
    cell: (info) => {
      const r = info.row.original;
      const Icon = isGithubUrl(r.url) ? GithubIcon : GlobeIcon;
      return (
        <a
          className="inline-flex items-center gap-1.5 font-mono text-accent underline-offset-2 hover:underline"
          href={r.url}
          target="_blank"
          rel="noreferrer"
          title={isGithubUrl(r.url) ? "GitHub repo" : "Homepage"}
        >
          {r.curated && (
            <span
              className="text-accent-bright"
              title="Curated — added via 'Add Tool'"
              aria-label="Curated record"
            >
              ★
            </span>
          )}
          <Icon />
          {info.getValue() as string}
        </a>
      );
    },
  },
  {
    accessorKey: "category",
    header: "Category",
    cell: (info) => (
      <span className="font-mono text-[11px] tracking-wide uppercase text-muted">
        {info.getValue() as string}
      </span>
    ),
  },
  {
    accessorKey: "stars",
    header: "Stars",
    cell: (info) => (
      <span className="font-mono text-sm">
        {info.row.original.stars_display ?? "—"}
      </span>
    ),
    sortingFn: "basic",
  },
  {
    accessorKey: "version",
    header: "Version",
    cell: (info) => (
      <span className="font-mono text-xs text-muted">
        {(info.getValue() as string | null) ?? "—"}
      </span>
    ),
    sortingFn: "alphanumeric",
  },
  {
    accessorKey: "contributors",
    header: "Contributors",
    cell: (info) => (
      <span className="font-mono text-sm">
        {(info.getValue() as number | null) ?? "—"}
      </span>
    ),
    sortingFn: "basic",
  },
  {
    accessorKey: "use_cases",
    header: "Use-cases",
    enableSorting: false,
    cell: (info) => (
      <div className="flex flex-wrap gap-1">
        {((info.getValue() as string[]) ?? []).map((u) => (
          <span key={u} className="rounded bg-raised border border-edge px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-muted">
            {u}
          </span>
        ))}
      </div>
    ),
  },
  { accessorKey: "description", header: "Description" },
];
