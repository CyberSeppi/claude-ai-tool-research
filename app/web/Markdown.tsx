import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

// Recursively pull plain text out of rendered children (for copy).
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in (node as any)) return textOf((node as any).props?.children);
  return "";
}

function CodeBlock({ className, children }: { className?: string; children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const lang = /language-(\w+)/.exec(className ?? "")?.[1] ?? "code";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(textOf(children).replace(/\n$/, ""));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };
  return (
    <div className="md-pane">
      <div className="md-pane-bar">
        <span className="md-pane-lang">{lang}</span>
        <button type="button" className="md-pane-copy" onClick={copy}>
          {copied ? "copied" : "copy"}
        </button>
      </div>
      <pre>
        <code className={className}>{children}</code>
      </pre>
    </div>
  );
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="md-link">
              {children}
            </a>
          ),
          // pre is a passthrough; the code component renders the full terminal pane.
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children }) => {
            const isBlock = /language-/.test(className ?? "") || textOf(children).includes("\n");
            return isBlock ? (
              <CodeBlock className={className}>{children}</CodeBlock>
            ) : (
              <code className="md-inline">{children}</code>
            );
          },
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
