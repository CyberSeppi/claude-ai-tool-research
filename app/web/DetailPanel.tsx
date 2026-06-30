import type { Rec } from "./types";
import { ChatBox } from "./ChatBox";
import { useResizable } from "./useResizable";

export function DetailPanel({ record, onFlag, onClose }: {
  record: Rec; onFlag: (id: string, interesting: boolean) => void; onClose: () => void;
}) {
  const { width, onPointerDown } = useResizable();
  return (
    <aside style={{ width }} className="fixed right-0 top-0 z-30 h-full overflow-y-auto bg-surface border-l border-edge p-5">
      <div
        onPointerDown={onPointerDown}
        className="absolute left-0 top-0 h-full w-1.5 cursor-ew-resize hover:bg-accent/40"
        title="Drag to resize"
        aria-label="Resize panel"
      />
      <div className="flex justify-between items-start">
        <a
          className="font-mono text-base font-medium text-accent underline-offset-2 hover:underline truncate"
          href={record.url}
          target="_blank"
          rel="noreferrer"
        >
          {record.name}
        </a>
        <button
          onClick={onClose}
          className="font-mono text-muted hover:text-primary transition-colors px-1"
          aria-label="Close panel"
        >
          ✕
        </button>
      </div>

      <div className="mt-1.5 font-mono text-[11px] tracking-wide text-muted">
        {record.category}
        {" · "}
        {record.stars_display ?? "—"}★
        {record.version && (
          <>
            {" · "}
            {record.version}
          </>
        )}
        {record.contributors != null && (
          <>
            {" · "}
            {record.contributors} contributors
          </>
        )}
      </div>

      <p className="mt-4 text-sm text-primary leading-relaxed">{record.description}</p>

      <p className="mt-2 font-mono text-[11px] text-muted">
        <span className="text-dim uppercase tracking-widest">Efficiency · </span>
        {record.efficiency_gain}
      </p>

      {record.use_cases?.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1">
          {record.use_cases.map((u) => (
            <span key={u} className="rounded bg-raised border border-edge px-1.5 py-0.5 font-mono text-[10px] tracking-wide text-muted">
              {u}
            </span>
          ))}
        </div>
      )}

      <button
        onClick={() => onFlag(record.id, !record.flagged)}
        className={`mt-4 rounded px-3 py-1.5 font-mono text-xs font-medium tracking-wide transition-colors
          ${record.flagged
            ? "bg-accent text-black"
            : "border border-edge text-muted hover:border-accent hover:text-accent"
          }`}
      >
        {record.flagged ? "★ Flagged" : "☆ Flag as interesting"}
      </button>

      <div className="mt-6 border-t border-edge pt-4">
        <ChatBox scope="record" ids={[record.id]} title={`Ask about ${record.name}`} />
      </div>
    </aside>
  );
}
