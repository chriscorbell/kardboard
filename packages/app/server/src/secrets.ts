import { createHash, timingSafeEqual } from "node:crypto";

// Whether `given` is the secret `expected`, compared in a time that does not depend on how much of it
// matches, so nobody can find a token a character at a time by timing the answers. Both are hashed
// first, which gives `timingSafeEqual` the equal lengths it needs without the secret's own length
// showing. An empty `expected` is a secret that was never set, and matches nothing.
export function sameSecret(given: string, expected: string): boolean {
  if (!expected) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(given), digest(expected));
}

// Whether an Authorization header carries `token` as its bearer token.
export function hasBearer(header: string | undefined, token: string): boolean {
  return sameSecret(header?.startsWith("Bearer ") ? header.slice(7) : "", token);
}
