// A Board's repository is a GitHub URL. kardboard never calls GitHub; it only reads the owner and
// name out of the URL, to check that a pull request an agent records belongs to the Board.
export function parseRepoUrl(url: string | null): { owner: string; repo: string } | null {
  if (!url) return null;
  const m = /^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}
