// A Board's repository is a GitHub URL. kardboard never calls GitHub; it reads the owner and name out
// of the URL, to find the Board an agent's checkout belongs to and to check that a pull request it
// records is in the Board's repository.

/**
 * The owner and name of a GitHub repository, from any way git or a person writes its address:
 * `https://github.com/o/r`, with or without `.git` or a trailing slash, `git@github.com:o/r.git`,
 * `ssh://git@github.com/o/r.git` with or without a port, a remote with credentials in it such as
 * `https://user:token@github.com/o/r.git`, or a bare `github.com/o/r`. Null for anything else.
 */
export function parseRepoUrl(url: string | null): { owner: string; repo: string } | null {
  if (!url) return null;
  const m = /^(?:(?:https?|ssh|git):\/\/)?(?:[^@/\s]+@)?(?:www\.)?github\.com(?::\d+)?[:/]([^/\s]+)\/([^/#?\s]+?)(?:\.git)?\/?$/i.exec(url.trim());
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

/** `owner/repo` in lowercase, to compare two addresses of the same repository. */
export function repositoryKey(url: string | null): string | null {
  const parsed = parseRepoUrl(url);
  return parsed ? `${parsed.owner}/${parsed.repo}`.toLowerCase() : null;
}
