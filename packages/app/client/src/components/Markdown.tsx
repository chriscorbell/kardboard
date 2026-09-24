import ReactMarkdown, { defaultUrlTransform, type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { useMemo } from "react";
import { remarkMentions } from "./mentions";

// Mentions arrive as links on a private "mention:" scheme and render as names. Every other URL goes
// through react-markdown's own sanitising, which drops schemes like javascript:.
function urlTransform(url: string): string {
  return url.startsWith("mention:") ? url : defaultUrlTransform(url);
}

export function Markdown({ body, handles, className }: { body: string; handles?: Map<string, string>; className?: string }) {
  const plugins = useMemo<NonNullable<Options["remarkPlugins"]>>(() => (handles ? [remarkGfm, [remarkMentions, handles]] : [remarkGfm]), [handles]);
  return (
    <div className={`prose-cb ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={plugins}
        urlTransform={urlTransform}
        components={{
          // `node` is react-markdown's syntax-tree node, not an attribute.
          a: ({ node: _node, href, children, ...rest }) => {
            if (href?.startsWith("mention:")) return <span className="mention">{children}</span>;
            return (
              <a href={href} target="_blank" rel="noreferrer" {...rest}>
                {children}
              </a>
            );
          },
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
