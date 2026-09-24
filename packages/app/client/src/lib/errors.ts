// A failed API request, with a message a person can read. `code` keeps the server's machine value.
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    public data: unknown,
  ) {
    super(describeError(status, code));
    this.name = "ApiError";
  }
}

// Status 0 stands for a request that got no answer at all: offline, a dropped connection, a restart.
export const NO_RESPONSE = 0;

// The server answers `{ error: string }`, but a validator can put an object there. Only a string is a code.
export function errorCode(data: unknown, status: number): string {
  const error = data && typeof data === "object" ? (data as { error?: unknown }).error : undefined;
  return typeof error === "string" && error.trim() ? error : `http_${status}`;
}

const CODES: Record<string, string> = {
  network: "Could not reach kardboard. Check your connection and try again.",
  unauthenticated: "Your session has ended. Sign in again.",
  not_invited: "This account no longer has access.",
  forbidden: "You do not have access to that.",
  not_found: "That no longer exists.",
  conflict: "Someone else changed this first.",
  invalid: "Some of those values are not valid.",
  missing: "That file is missing on the server.",
};

const STATUSES: Record<number, string> = {
  400: CODES.invalid!,
  401: CODES.unauthenticated!,
  403: CODES.forbidden!,
  404: CODES.not_found!,
  409: CODES.conflict!,
  413: "That file is too large.",
  422: CODES.invalid!,
  429: "Too many requests. Try again in a moment.",
};

export function describeError(status: number, code: string): string {
  const known = CODES[code];
  if (known) return known;
  // A code is snake_case. Anything else is a sentence the server wrote for people, like "slug already in use".
  if (!/^[a-z0-9_]+$/.test(code)) return sentence(code);
  if (STATUSES[status]) return STATUSES[status];
  if (status >= 500) return `The server ran into a problem (${status}). Try again in a moment.`;
  return `The request failed (${status}).`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  const capital = trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
  return /[.!?]$/.test(capital) ? capital : `${capital}.`;
}

// Worth another try: no answer, or a server error. A 4xx fails the same way the second time.
export function shouldRetry(failureCount: number, error: unknown, limit = 2): boolean {
  if (failureCount >= limit) return false;
  if (error instanceof ApiError) return error.status === NO_RESPONSE || error.status >= 500;
  return true;
}
