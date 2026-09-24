// A Board slug while it is being typed: lowercase, and each run of other characters becomes one
// hyphen. A trailing hyphen stays, because the next keystroke may follow it; a leading one never helps.
export function slugDraft(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").slice(0, 48);
}

// The slug as saved: no hyphen at either end.
export function slugify(s: string): string {
  return slugDraft(s).replace(/-+$/, "");
}
