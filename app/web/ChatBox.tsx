import { useState } from "react";
import { api } from "./api";
import type { ChatScope } from "./types";
import { Markdown } from "./Markdown";

export function ChatBox({ scope, ids, title }: { scope: ChatScope; ids: string[]; title: string }) {
  const [message, setMessage] = useState("");
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const send = async () => {
    if (!message.trim()) return;
    setBusy(true); setError(""); setAnswer("");
    try {
      const r = await api.chat(scope, ids, message);
      if (r.error) setError(r.error); else setAnswer(r.answer ?? "");
    } catch (e) { setError(String(e)); } finally { setBusy(false); }
  };

  return (
    <div className="mt-3">
      <div className="font-mono text-[10px] tracking-widest uppercase text-muted mb-2">{title}</div>
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Ask about this…"
        rows={3}
        className="w-full rounded bg-raised border border-edge px-3 py-2 text-sm text-primary placeholder:text-dim focus:outline-none focus:ring-1 focus:ring-accent focus:border-accent resize-y"
      />
      <button
        onClick={send}
        disabled={busy}
        className="mt-2 rounded bg-accent px-4 py-1.5 font-mono text-xs font-medium tracking-wide text-black hover:bg-accent-bright disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
      >
        {busy ? "Thinking…" : "Send"}
      </button>
      {error && (
        <p className="mt-2 font-mono text-xs text-danger">{error}</p>
      )}
      {answer && (
        <div className="mt-3">
          <Markdown>{answer}</Markdown>
        </div>
      )}
    </div>
  );
}
