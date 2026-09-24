import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { MENTION_RE } from "@kardboard/shared";
import { useMemo } from "react";

// Mentions become links on a private "mention:" scheme so react-markdown can render them as names.
function markMentions(body: string, handles: Map<string, string>): string {
  return body.replace(MENTION_RE, (_m, pre: string, handle: string) => {
    const name = handles.get(handle.toLowerCase());
    return `${pre}[@${name ?? handle}](mention:${handle})`;
  });
}

export function Markdown({ body, handles, className }: { body: string; handles?: Map<string, string>; className?: string }) {
  const text = useMemo(() => (handles ? markMentions(body, handles) : body), [body, handles]);
  return (
    <div className={`prose-cb ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        urlTransform={(url) => url}
        components={{
          a: ({ href, children, ...rest }) => {
            if (href?.startsWith("mention:")) return <span className="mention">{children}</span>;
            return (
              <a href={href} target="_blank" rel="noreferrer" {...rest}>
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
