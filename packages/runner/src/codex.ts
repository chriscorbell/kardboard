// How a Session container gets a Codex credential. There are two ways, and a Session must have
// exactly one of them or it will start, fail to reach the provider, and burn a concurrency slot
// for nothing — so the runner refuses the start instead.
//
//   egress  The proxy holds the sign-in file and injects the credential (ADR 0002's intent). The
//           container carries no Codex credential at all.
//   mount   The host's sign-in file is bound into the container read-only at a staging path. The
//           entrypoint copies it to $HOME/.codex/auth.json, because Codex rewrites that file when
//           it refreshes its access token and must not write back to the Admin's copy.

/** Where the runner binds the host sign-in file. The entrypoint reads it from here, never in place. */
export const CODEX_AUTH_STAGE = "/run/kardboard/codex-auth.json";

export type CodexWiringInput = {
  /** KARDBOARD_CODEX_VIA_EGRESS: the egress proxy has been given the sign-in file. */
  viaEgress: boolean;
  /** Base URL of the egress proxy, without a trailing slash. */
  egressUrl: string;
  /** CODEX_AUTH_FILE: a path on the Docker host, not inside the runner. */
  authFile: string;
};

export type CodexWiring = { env: string[]; binds: string[] } | { error: string };

export function codexWiring(input: CodexWiringInput): CodexWiring {
  if (input.viaEgress) {
    // Codex only sends inference over plain HTTP when the provider is a named one; the default
    // provider prefers a WebSocket to chatgpt.com, which ignores any base URL and so escapes the
    // proxy. Verified against codex-cli 0.154.0.
    return { env: [`KARDBOARD_CODEX_EGRESS_URL=${input.egressUrl}/openai`], binds: [] };
  }
  if (input.authFile) {
    return { env: [`KARDBOARD_CODEX_AUTH_STAGE=${CODEX_AUTH_STAGE}`], binds: [`${input.authFile}:${CODEX_AUTH_STAGE}:ro`] };
  }
  return {
    error:
      "codex sessions need a credential: set KARDBOARD_CODEX_VIA_EGRESS=1 once the egress proxy holds the sign-in file, or point CODEX_AUTH_FILE at it on the Docker host",
  };
}
