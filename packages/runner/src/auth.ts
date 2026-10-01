import { createHash, timingSafeEqual } from "node:crypto";

// Every call to the runner carries the token it shares with the app as a bearer header. A plain
// string comparison returns as soon as one byte differs, so how long a refusal takes says how much
// of a guess was right. Both sides are hashed first, which gives `timingSafeEqual` the equal lengths
// it needs and keeps the token's own length out of the timing too.

const digest = (text: string) => createHash("sha256").update(text).digest();

export function bearerMatches(header: string | undefined, token: string): boolean {
  // The runner will not start without a token, but an empty one here would let `Bearer ` through.
  if (!token) return false;
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${token}`));
}
