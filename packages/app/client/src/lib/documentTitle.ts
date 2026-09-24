import { useEffect } from "react";

const APP = "kardboard";

// The tab names what is open, so several boards and cards in several tabs can be told apart.
export function documentTitle(parts: (string | null | undefined)[]): string {
  return [...parts.filter((p): p is string => Boolean(p && p.trim())), APP].join(" · ");
}

export function useDocumentTitle(title: string | null) {
  useEffect(() => {
    if (!title) return;
    document.title = title;
    return () => {
      document.title = APP;
    };
  }, [title]);
}
