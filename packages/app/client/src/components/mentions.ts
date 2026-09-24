import { MENTION_RE } from "@kardboard/shared";

// The few mdast shapes this touches; the full mdast types are not a direct dependency.
export type MdNode = { type: string; value?: string; url?: string; children?: MdNode[] };

// A remark plugin that turns @handles into links on a private "mention:" scheme, which the renderer
// shows as names. It rewrites text nodes only, so `inlineCode` and `code` keep their text as typed
// (`@tanstack/react-query` stays a package name), and it leaves link text alone.
export function remarkMentions(handles: Map<string, string>) {
  return (tree: MdNode) => {
    rewrite(tree, handles);
  };
}

function rewrite(node: MdNode, handles: Map<string, string>): void {
  if (!node.children || node.type === "link" || node.type === "linkReference") return;
  node.children = node.children.flatMap((child) => {
    if (child.type === "text" && child.value) return splitMentions(child.value, handles);
    rewrite(child, handles);
    return [child];
  });
}

export function splitMentions(text: string, handles: Map<string, string>): MdNode[] {
  const out: MdNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MENTION_RE)) {
    const handle = m[2]!;
    const at = m.index + m[1]!.length;
    if (at > last) out.push({ type: "text", value: text.slice(last, at) });
    out.push({ type: "link", url: `mention:${handle}`, children: [{ type: "text", value: `@${handles.get(handle.toLowerCase()) ?? handle}` }] });
    last = at + 1 + handle.length;
  }
  if (out.length === 0) return [{ type: "text", value: text }];
  if (last < text.length) out.push({ type: "text", value: text.slice(last) });
  return out;
}
