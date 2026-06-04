import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "../../lib/cn";

/** Fenced code blocks carry a `language-*` class; inline code does not. Hoisted per biome's top-level-regex rule. */
const LANGUAGE_CLASS_RE = /language-/;

interface MarkdownProps {
  /** The markdown source to render (e.g. a model response). */
  children: string;
  className?: string;
}

/**
 * Reusable markdown renderer for model-authored text (responses, summaries, …). Wraps `react-markdown`
 * + `remark-gfm` — secure by default (it renders React elements, never raw HTML, so model text cannot
 * inject markup) — with a compact, dark-theme element map tuned for dense panes rather than the looser
 * `prose` defaults. Reuse it anywhere a string is really markdown.
 */
export function Markdown({ children, className }: MarkdownProps): React.JSX.Element {
  return (
    <div className={cn("text-sm leading-relaxed", className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}

/** Compact, on-theme element styling — only `children` (and `href`/`className` where needed) are forwarded, so
 *  the hast `node` is never spread onto a DOM element. */
const MARKDOWN_COMPONENTS: Components = {
  h1: ({ children }) => <h1 className="mt-3 mb-1 font-semibold text-[15px] first:mt-0">{children}</h1>,
  h2: ({ children }) => <h2 className="mt-3 mb-1 font-semibold text-sm first:mt-0">{children}</h2>,
  h3: ({ children }) => <h3 className="mt-2 mb-1 font-semibold text-[13px] first:mt-0">{children}</h3>,
  p: ({ children }) => <p className="my-1.5 first:mt-0 last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 ml-4 list-disc space-y-0.5 marker:text-muted-foreground">{children}</ul>,
  ol: ({ children }) => (
    <ol className="my-1.5 ml-4 list-decimal space-y-0.5 marker:text-muted-foreground">{children}</ol>
  ),
  li: ({ children }) => <li className="pl-0.5">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      className="text-primary underline underline-offset-2 hover:text-primary/80"
    >
      {children}
    </a>
  ),
  strong: ({ children }) => <strong className="font-semibold text-foreground">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  blockquote: ({ children }) => (
    <blockquote className="my-1.5 border-border/70 border-l-2 pl-3 text-foreground/80">{children}</blockquote>
  ),
  hr: () => <hr className="my-3 border-border/60" />,
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-md border border-border/60 bg-background/60 p-2.5 text-[11px] leading-relaxed">
      {children}
    </pre>
  ),
  code: ({ className, children }) => {
    const isBlock = LANGUAGE_CLASS_RE.test(className ?? "") || String(children ?? "").includes("\n");
    return isBlock ? (
      <code className="font-mono text-[11px]">{children}</code>
    ) : (
      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px] text-foreground/90">{children}</code>
    );
  },
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-border/60 px-2 py-1 text-left font-semibold">{children}</th>,
  td: ({ children }) => <td className="border border-border/60 px-2 py-1">{children}</td>,
};
