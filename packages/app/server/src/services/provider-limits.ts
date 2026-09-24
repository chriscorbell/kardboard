import { z } from "zod";
import type { Provider } from "@kardboard/shared";
import { env } from "../env.js";

// The egress proxy is the only part of the stack that sees a provider's own answer, so it is where a
// usage refusal is observed; this reads what it saw. Never throws: a proxy that cannot be reached
// means "nothing known", and a Session then starts on the Board's Provider as it always did.

export interface UsageLimit {
  /** When the proxy saw the provider refuse a request for want of usage, ISO 8601. */
  at: string;
  /** When the provider said the window reopens, ISO 8601, or null when it did not say. */
  until: string | null;
}

export type LimitSnapshot = Record<Provider, UsageLimit | null>;

export const NO_LIMITS: LimitSnapshot = { claude: null, codex: null };

const limitSchema = z.object({ at: z.string(), until: z.string().nullable() }).nullable();
const snapshotSchema = z.object({ claude: limitSchema, codex: limitSchema });

export async function readProviderLimits(): Promise<LimitSnapshot> {
  if (!env.egressUrl) return NO_LIMITS;
  try {
    const res = await fetch(`${env.egressUrl}/limits`, {
      headers: env.runnerToken ? { Authorization: `Bearer ${env.runnerToken}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.warn(`[limits] egress answered ${res.status}; treating provider usage as unknown`);
      return NO_LIMITS;
    }
    const parsed = snapshotSchema.safeParse(await res.json());
    if (!parsed.success) {
      console.warn("[limits] egress sent something unexpected; treating provider usage as unknown");
      return NO_LIMITS;
    }
    return parsed.data;
  } catch (err) {
    console.warn("[limits] could not read provider limits from egress", (err as Error).message);
    return NO_LIMITS;
  }
}
