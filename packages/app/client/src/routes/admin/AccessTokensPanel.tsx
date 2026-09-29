import { useEffect, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Check, Copy, KeyRound } from "lucide-react";
import type { AccessToken, CreatedAccessToken } from "@kardboard/shared";
import { useAccessTokens, useCreateAccessToken, useRevokeAccessToken } from "../../lib/api";
import { Button, IconButton, Input, Skeleton } from "../../components/ui";
import { relativeTime } from "../../lib/format";
import { toast } from "../../lib/toast";
import { claudeMcpAddCommand } from "./accessTokens";

// The Admin's tokens for their own agent on a Board without Sessions. A new token's secret lives only
// in this component's state until the Admin is done with it: the server never shows it again. This
// sits inside the board settings form, so every button here is `type="button"` and Enter in the name
// field creates a token rather than saving the board.
export function AccessTokensPanel({ boardId, agentName }: { boardId: string; agentName: string }) {
  const tokens = useAccessTokens(boardId);
  const create = useCreateAccessToken(boardId);
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
    <div>
      <p className="text-[13px] font-medium text-ink-muted">Access tokens</p>
      <p className="mt-1 text-[12.5px] leading-relaxed text-ink-faint">Your own coding agent can work this board as {agentName} over MCP. A token reaches this board only.</p>
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
            <TokenRow key={t.id} token={t} boardId={boardId} fresh={t.id === created?.accessToken.id} />
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
          placeholder="Name it after where it runs, such as Laptop"
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
    </div>
  );
}

function TokenRow({ token, boardId, fresh }: { token: AccessToken; boardId: string; fresh: boolean }) {
  const revoke = useRevokeAccessToken(boardId);
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

function NewSecret({ created, onDone }: { created: CreatedAccessToken; onDone: () => void }) {
  const command = claudeMcpAddCommand(window.location.origin, created.secret);
  return (
    <div className="mt-3 flex flex-col gap-2.5 rounded-control border border-accent/30 bg-accent-soft/40 p-3">
      <p className="text-[12.5px] text-ink">
        <span className="font-medium">Copy the token for {created.accessToken.name} now.</span> It won't be shown again.
      </p>
      <Secret value={created.secret} label="Copy token" />
      <p className="text-[12.5px] text-ink-muted">To add this board to Claude Code, run this in your project's folder:</p>
      <Secret value={command} label="Copy command" />
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
