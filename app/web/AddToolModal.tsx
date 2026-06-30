import { useState } from "react";
import { api, ApiError } from "./api";
import type { EnrichedRecord, Rec } from "./types";

type Stage = "idle" | "fetching" | "preview" | "saving";

const CATEGORIES: Rec["category"][] = [
  "plugin-skill",
  "mcp-server",
  "token-tool",
  "companion-app",
];

export function AddToolModal({
  open,
  onClose,
  onAdded,
}: {
  open: boolean;
  onClose: () => void;
  onAdded: () => void;
}) {
  const [stage, setStage] = useState<Stage>("idle");
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [preview, setPreview] = useState<EnrichedRecord | null>(null);
  const [error, setError] = useState<string>("");

  function reset() {
    setStage("idle");
    setUrl("");
    setName("");
    setPreview(null);
    setError("");
  }

  async function fetchPreview() {
    setStage("fetching");
    setError("");
    try {
      const { enriched } = await api.enrichTool({ url: url.trim(), name: name.trim() || undefined });
      setPreview(enriched);
      setStage("preview");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
      setStage("idle");
    }
  }

  async function save() {
    if (!preview) return;
    setStage("saving");
    setError("");
    try {
      await api.addTool({
        name: preview.name,
        url: preview.url,
        repo_url: preview.repo_url,
        category: preview.category,
        description: preview.description,
        efficiency_gain: preview.efficiency_gain,
        use_cases: preview.use_cases,
        sources: preview.sources,
        confidence: preview.confidence,
        stars: preview.stars,
        stars_display: preview.stars_display,
        version: preview.version,
        contributors: preview.contributors,
      });
      onAdded();
      reset();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        const existing = String(err.body.existing ?? "");
        setError(
          existing === "raw"
            ? "The crawler already lists this tool — no need to add it manually."
            : "You've already curated this tool — edit it in its detail panel.",
        );
      } else {
        setError(err instanceof Error ? err.message : "Unknown error");
      }
      setStage("preview");
    }
  }

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded border border-edge bg-surface p-6 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-4">
          <h2 className="font-mono text-base tracking-widest uppercase text-primary">Add Tool</h2>
          <button
            onClick={() => {
              reset();
              onClose();
            }}
            className="font-mono text-muted hover:text-primary"
            aria-label="Close"
          >
            ✕
          </button>
        </div>

        {stage === "idle" || stage === "fetching" ? (
          <div className="space-y-3">
            <label className="block font-mono text-[11px] text-muted uppercase tracking-widest">
              URL
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/owner/repo or https://example.com"
                className="mt-1 w-full rounded bg-raised border border-edge px-3 py-1.5 text-sm text-primary placeholder:text-dim focus:outline-none focus:ring-1 focus:ring-accent"
                autoFocus
              />
            </label>
            <label className="block font-mono text-[11px] text-muted uppercase tracking-widest">
              Name (optional — auto-filled when blank)
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Obsidian"
                className="mt-1 w-full rounded bg-raised border border-edge px-3 py-1.5 text-sm text-primary placeholder:text-dim focus:outline-none focus:ring-1 focus:ring-accent"
              />
            </label>
            {error && <p className="font-mono text-xs text-danger">{error}</p>}
            <button
              onClick={fetchPreview}
              disabled={stage === "fetching" || !url.trim()}
              className="rounded bg-accent px-4 py-1.5 font-mono text-xs font-medium tracking-wide text-black hover:bg-accent-bright disabled:opacity-30"
            >
              {stage === "fetching" ? "Fetching…" : "Fetch"}
            </button>
          </div>
        ) : (
          <PreviewForm
            preview={preview!}
            onChange={setPreview}
            onSave={save}
            onBack={() => setStage("idle")}
            saving={stage === "saving"}
            error={error}
          />
        )}
      </div>
    </div>
  );
}

function PreviewForm({
  preview,
  onChange,
  onSave,
  onBack,
  saving,
  error,
}: {
  preview: EnrichedRecord;
  onChange: (p: EnrichedRecord) => void;
  onSave: () => void;
  onBack: () => void;
  saving: boolean;
  error: string;
}) {
  function update<K extends keyof EnrichedRecord>(key: K, value: EnrichedRecord[K]) {
    onChange({ ...preview, [key]: value });
  }
  return (
    <div className="space-y-3 max-h-[70vh] overflow-y-auto pr-1">
      <Field label="Name">
        <input
          value={preview.name}
          onChange={(e) => update("name", e.target.value)}
          className="w-full rounded bg-raised border border-edge px-3 py-1.5 text-sm"
        />
      </Field>
      <Field label="URL">
        <input
          value={preview.url}
          onChange={(e) => update("url", e.target.value)}
          className="w-full rounded bg-raised border border-edge px-3 py-1.5 text-sm"
        />
      </Field>
      <Field label="Category">
        <select
          value={preview.category}
          onChange={(e) => update("category", e.target.value as Rec["category"])}
          className="w-full rounded bg-raised border border-edge px-2 py-1.5 text-sm"
        >
          {CATEGORIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </Field>
      <Field label="Description">
        <textarea
          value={preview.description}
          onChange={(e) => update("description", e.target.value)}
          rows={3}
          className="w-full rounded bg-raised border border-edge px-3 py-1.5 text-sm resize-y"
        />
      </Field>
      <Field label="Efficiency Gain">
        <textarea
          value={preview.efficiency_gain}
          onChange={(e) => update("efficiency_gain", e.target.value)}
          rows={2}
          className="w-full rounded bg-raised border border-edge px-3 py-1.5 text-sm resize-y"
        />
      </Field>
      <Field label="Use-cases (comma-separated)">
        <input
          value={preview.use_cases.join(", ")}
          onChange={(e) =>
            update(
              "use_cases",
              e.target.value
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            )
          }
          className="w-full rounded bg-raised border border-edge px-3 py-1.5 text-sm"
        />
      </Field>
      {preview.free === false && (
        <p className="rounded border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 font-mono text-[11px] text-yellow-200">
          ⚠ The extractor thinks this tool may not be fully free.
          {preview.free_check_reason ? ` Reason: "${preview.free_check_reason}"` : ""}
        </p>
      )}
      {error && <p className="font-mono text-xs text-danger">{error}</p>}
      <div className="flex gap-2 pt-2 border-t border-edge">
        <button
          onClick={onBack}
          disabled={saving}
          className="rounded border border-edge px-3 py-1.5 font-mono text-xs text-muted hover:text-primary disabled:opacity-30"
        >
          Back
        </button>
        <button
          onClick={onSave}
          disabled={saving}
          className="rounded bg-accent px-4 py-1.5 font-mono text-xs font-medium tracking-wide text-black hover:bg-accent-bright disabled:opacity-30"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="block font-mono text-[11px] text-muted uppercase tracking-widest">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </label>
  );
}
