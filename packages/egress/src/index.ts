import http from "node:http";
import { URL } from "node:url";
import { CodexCredential } from "./codex-credential.js";
import { UsageLimits } from "./limits.js";
import { createProxy } from "./proxy.js";

// Credential-injecting egress proxy. Session containers never hold the provider token; they send
// requests here and the proxy adds the real credential before forwarding to the provider.
//
// Routes:
//   /anthropic/* -> https://api.anthropic.com/*              (Claude Code with ANTHROPIC_BASE_URL)
//   /openai/*    -> https://chatgpt.com/backend-api/codex/*  (Codex with a named model provider)
//   /limits      -> the last usage refusal seen per Provider (the app, with the control token)
//
// Only the provider calls listed in `ALLOWED_CALLS` in proxy.ts go upstream; the rest get a 403.
//
// Verified 2026-09-14: a raw /v1/messages call from a workload container with no credential
// received a model reply through this proxy, so the bearer plus oauth beta rewrite is accepted
// upstream. Claude Code itself is launched with a placeholder ANTHROPIC_API_KEY so it uses the
// API-key path; the x-api-key header it sends is dropped here.
//
// Verified 2026-09-15: the /openai route reached the real ChatGPT backend and a Codex Session
// holding no credential completed a turn through it. The route is off unless CODEX_AUTH_FILE
// names a Codex sign-in file.

const port = Number(process.env.PORT ?? "8787");
const claudeToken = process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "";
const codexAuthFile = process.env.CODEX_AUTH_FILE ?? "";
const controlToken = process.env.EGRESS_CONTROL_TOKEN ?? "";

if (!claudeToken) console.warn("[egress] CLAUDE_CODE_OAUTH_TOKEN is empty; Claude Code requests will fail upstream");
if (!codexAuthFile) console.warn("[egress] CODEX_AUTH_FILE is empty; Codex requests are refused and Sessions must mount the sign-in file");
if (!controlToken) console.warn("[egress] EGRESS_CONTROL_TOKEN is empty; /limits is readable by anything that can reach this proxy, Session containers included");

const codex = codexAuthFile
  ? new CodexCredential(codexAuthFile, {
      clientId: process.env.EGRESS_CODEX_CLIENT_ID,
      tokenUrl: process.env.EGRESS_CODEX_TOKEN_URL,
      onRefresh: () => console.log("[egress] refreshed the codex access token"),
    })
  : null;

const server = http.createServer(
  createProxy({
    claudeToken,
    anthropicUpstream: new URL(process.env.EGRESS_ANTHROPIC_UPSTREAM ?? "https://api.anthropic.com"),
    codexUpstream: new URL(process.env.EGRESS_CODEX_UPSTREAM ?? "https://chatgpt.com/backend-api/codex"),
    codex,
    allowedNetworks: (process.env.EGRESS_ALLOWED_CIDRS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    limits: new UsageLimits(),
    controlToken,
  }),
);

server.listen(port, () => console.log(`kardboard egress listening on :${port}`));
