import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";

// react-markdown sanitises every URL itself, which drops schemes like javascript:.
const PLUGINS: NonNullable<Options["remarkPlugins"]> = [remarkGfm];

export function Markdown({ body, className }: { body: string; className?: string }) {
  return (
    <div className={`prose-cb ${className ?? ""}`}>
      <ReactMarkdown
        remarkPlugins={PLUGINS}
        components={{
          // `node` is react-markdown's syntax-tree node, not an attribute.
          a: ({ node: _node, href, children, ...rest }) => (
            <a href={href} target="_blank" rel="noreferrer" {...rest}>
              {children}
            </a>
          ),
        }}
      >
        {body}
      </ReactMarkdown>
    </div>
  );
}
