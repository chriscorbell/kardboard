import { z } from "zod";
import { PROVIDERS, providerSchema, type Provider, type ProvidersView } from "@kardboard/shared";
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
// Everything past the two Provider keys arrived with the credential and refusal reporting, and is
// read on its own: provider fallback depends on the keys, and nothing wrong with the rest may cost
// it them. A proxy from before sends only the keys, which reads here as "nothing seen".
const authFailureSchema = z.object({ at: z.string(), status: z.number().nullable(), reason: z.string() }).nullable();
const extrasSchema = z.object({
  authFailures: z.object({ claude: authFailureSchema, codex: authFailureSchema }).optional(),
  refusals: z
    .object({
      count: z.number(),
      last: z.object({ at: z.string(), provider: providerSchema, method: z.string(), path: z.string() }).nullable(),
    })
    .optional(),
  credentials: z.object({ claude: z.boolean(), codex: z.boolean() }).optional(),
});

/** What the app knows about the egress proxy right now: everything `/limits` said, or why nothing. */
export type EgressStatus = ProvidersView & { limits: LimitSnapshot };

function unknownStatus(egress: EgressStatus["egress"], checkedAt: string): EgressStatus {
  return {
    egress,
    checkedAt,
    limits: NO_LIMITS,
    providers: PROVIDERS.map((provider) => ({ provider, credentialLoaded: null, limit: null, authFailure: null })),
    refusals: { count: 0, last: null },
  };
}

export async function readEgressStatus(now = new Date()): Promise<EgressStatus> {
  const checkedAt = now.toISOString();
  if (!env.egressUrl) return unknownStatus("unconfigured", checkedAt);
  try {
    const res = await fetch(`${env.egressUrl}/limits`, {
      headers: env.runnerToken ? { Authorization: `Bearer ${env.runnerToken}` } : {},
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) {
      console.warn(`[limits] egress answered ${res.status}; treating provider usage as unknown`);
      return unknownStatus("unreachable", checkedAt);
    }
    const body: unknown = await res.json();
    const parsed = snapshotSchema.safeParse(body);
    if (!parsed.success) {
      console.warn("[limits] egress sent something unexpected; treating provider usage as unknown");
      return unknownStatus("unreachable", checkedAt);
    }
    const limits = parsed.data;
    const extrasParsed = extrasSchema.safeParse(body);
    if (!extrasParsed.success) console.warn("[limits] egress sent an unexpected credential or refusal report; showing usage limits only");
    const extras = extrasParsed.success ? extrasParsed.data : {};
    return {
      egress: "reachable",
      checkedAt,
      limits,
      providers: PROVIDERS.map((provider) => ({
        provider,
        credentialLoaded: extras.credentials?.[provider] ?? null,
        limit: limits[provider],
        authFailure: extras.authFailures?.[provider] ?? null,
      })),
      refusals: extras.refusals ?? { count: 0, last: null },
    };
  } catch (err) {
    console.warn("[limits] could not read provider limits from egress", (err as Error).message);
    return unknownStatus("unreachable", checkedAt);
  }
}

export async function readProviderLimits(): Promise<LimitSnapshot> {
  return (await readEgressStatus()).limits;
}
