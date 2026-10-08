import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, Copy, KeyRound } from "lucide-react";
import type { AccessToken, CreatedAccessToken } from "@kardboard/shared";
import { useAccessTokens, useCreateAccessToken, useRevokeAccessToken } from "../../lib/api";
import { Button, cx, IconButton, Input, Skeleton } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { toast } from "../../lib/toast";
import { claudeMcpAddCommand, codexMcpAddCommands } from "./accessTokens";

// The User's tokens for their own agents, each reaching every Board. A new token's secret lives only
// in this component's state until the User is done with it: the server never shows it again.
export function AccessTokensPanel({ agentName }: { agentName: string }) {
  const tokens = useAccessTokens();
  const create = useCreateAccessToken();
  const [name, setName] = useState("");
  const [created, setCreated] = useState<CreatedAccessToken | null>(null);
  const reduce = useReducedMotion();

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed || create.isPending) return;
    create.mutate(trimmed, {
      onSuccess: (made) => {
        setCreated(made);
        setName("");
      },
    });
  };

  return (
    <section aria-labelledby="access-tokens-title" className="mt-10 max-w-lg border-t border-line pt-8">
      <h2 id="access-tokens-title" className="text-[15px] font-semibold tracking-tight text-ink">
        Connect an agent
      </h2>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-muted">
        A token lets a coding agent on your machine read and change every board as {agentName}. It finds the board for the repository it is working in, and files what it notices along the way.
      </p>
      <AnimatePresence initial={false}>
        {created ? (
          <motion.div
            key={created.accessToken.id}
            initial={reduce ? false : { height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <NewSecret created={created} onDone={() => setCreated(null)} />
          </motion.div>
        ) : null}
      </AnimatePresence>
      {tokens.isPending ? (
        <Skeleton className="mt-3 h-12" />
      ) : tokens.data && tokens.data.length > 0 ? (
        <ul className="mt-3 divide-y divide-line rounded-card border border-line">
          {tokens.data.map((t) => (
            <TokenRow key={t.id} token={t} fresh={t.id === created?.accessToken.id} />
          ))}
        </ul>
      ) : null}
      <div className="mt-3 flex gap-2">
        <Input
          aria-label="Token name"
          value={name}
          maxLength={80}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            submit();
          }}
          placeholder="Where it runs, such as Laptop"
        />
        <Button type="button" icon={<KeyRound className="size-4" strokeWidth={1.75} />} loading={create.isPending} disabled={!name.trim()} onClick={submit}>
          Create token
        </Button>
      </div>
      {create.isError ? (
        <p role="alert" className="mt-2 text-[12.5px] text-danger">
          {create.error.message}
        </p>
      ) : null}
    </section>
  );
}

function TokenRow({ token, fresh }: { token: AccessToken; fresh: boolean }) {
  const revoke = useRevokeAccessToken();
  const [confirming, setConfirming] = useState(false);
  return (
    <li className="flex items-center gap-3 px-3 py-2.5">
      <KeyRound className="size-4 shrink-0 text-ink-faint" strokeWidth={1.75} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-ink">{token.name}</p>
        <p className="text-[12px] text-ink-faint">
          Created {relativeTime(token.createdAt)} · {token.lastUsedAt ? `last used ${relativeTime(token.lastUsedAt)}` : fresh ? "not used yet" : "never used"}
        </p>
      </div>
      {confirming ? (
        <span className="flex shrink-0 items-center gap-1">
          <Button type="button" size="sm" variant="ghost" onClick={() => setConfirming(false)}>
            Keep
          </Button>
          <Button type="button" size="sm" variant="danger" loading={revoke.isPending} onClick={() => revoke.mutate(token.id, { onError: (err) => toast(`The token was not revoked. ${err.message}`) })}>
            Revoke
          </Button>
        </span>
      ) : (
        <Button type="button" size="sm" variant="ghost" className="shrink-0" onClick={() => setConfirming(true)} aria-label={`Revoke ${token.name}`}>
          Revoke
        </Button>
      )}
    </li>
  );
}

const AGENTS = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
] as const;

// The secret once, and how to install it in either agent. Both install for the user, not one project,
// so the agent has kardboard in every checkout.
function NewSecret({ created, onDone }: { created: CreatedAccessToken; onDone: () => void }) {
  const [agent, setAgent] = useState<(typeof AGENTS)[number]["id"]>("claude");
  const reduce = useReducedMotion();
  const codex = codexMcpAddCommands(window.location.origin, created.secret);
  return (
    <div className="mt-4 flex flex-col gap-3 rounded-control border border-accent/30 bg-accent-soft/40 p-3">
      <p className="text-[12.5px] text-ink">
        <span className="font-medium">Copy the token for {created.accessToken.name} now.</span> It won't be shown again.
      </p>
      <Secret value={created.secret} label="Copy token" />
      <div role="tablist" aria-label="Install it in" className="relative flex w-fit gap-0.5 rounded-control border border-line bg-bg p-0.5">
        {AGENTS.map((a) => (
          <button
            key={a.id}
            type="button"
            role="tab"
            aria-selected={agent === a.id}
            onClick={() => setAgent(a.id)}
            className={cx("relative rounded-[6px] px-2.5 py-1 text-[12.5px] transition-colors", agent === a.id ? "text-ink" : "text-ink-muted hover:text-ink")}
          >
            {agent === a.id ? <motion.span layoutId="agent-tab" transition={reduce ? { duration: 0 } : { type: "spring", stiffness: 500, damping: 40 }} className="absolute inset-0 rounded-[6px] bg-raised" /> : null}
            <span className="relative">{a.label}</span>
          </button>
        ))}
      </div>
      {agent === "claude" ? (
        <>
          <p className="text-[12.5px] text-ink-muted">Run this once, anywhere:</p>
          <Secret value={claudeMcpAddCommand(window.location.origin, created.secret)} label="Copy command" />
          <p className="text-[12.5px] leading-relaxed text-ink-muted">
            So it doesn't ask before every board action, add <code className="font-mono text-[12px] text-ink">mcp__kardboard</code> to <code className="font-mono text-[12px] text-ink">permissions.allow</code> in{" "}
            <code className="font-mono text-[12px] text-ink">~/.claude/settings.json</code>.
          </p>
        </>
      ) : (
        <>
          <p className="text-[12.5px] text-ink-muted">Put this in your shell profile, so Codex can read the token:</p>
          <Secret value={codex.env} label="Copy line" />
          <p className="text-[12.5px] text-ink-muted">Then run this once:</p>
          <Secret value={codex.add} label="Copy command" />
        </>
      )}
      <div>
        <Button type="button" size="sm" variant="secondary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}

function Secret({ value, label }: { value: string; label: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
    } catch {
      toast("It was not copied. Select it and copy it by hand instead.");
    }
  };
  return (
    <div className="flex items-start gap-1 rounded-control border border-line bg-bg py-1 pl-3 pr-1">
      <code className="min-w-0 flex-1 select-all break-all py-1 font-mono text-[12px] leading-relaxed text-ink">{value}</code>
      <IconButton type="button" label={copied ? "Copied" : label} className="size-7 shrink-0" onClick={() => void copy()}>
        <AnimatePresence mode="wait" initial={false}>
          <motion.span key={copied ? "done" : "copy"} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={{ duration: 0.12 }} className="inline-flex">
            {copied ? <Check className="size-4 text-ok" strokeWidth={2} /> : <Copy className="size-4" strokeWidth={1.75} />}
          </motion.span>
        </AnimatePresence>
        <span className="sr-only" aria-live="polite">
          {copied ? "Copied" : ""}
        </span>
      </IconButton>
    </div>
  );
}
