import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Archive, ArrowUpRight, Check, CircleCheck, CircleDashed, CircleHelp, CircleMinus, CircleX, MessageSquarePlus, RotateCcw, TriangleAlert, type LucideIcon } from "lucide-react";
import { describeChecks, type Approval, type Card, type CheckState, type ChecksSummary, type Person } from "@kardboard/shared";
import { Button, cx } from "../../components/ui";
import { Dialog } from "../../components/Dialog";
import { relativeTime } from "../../lib/format";
import { useApproveCard, useMoveCard, useRetryMerge, useSyncCard } from "../../lib/api";
import { approveGate, CHECK_TONES, checksPageUrl, closeStatement, currentChecks, mergeStatement, reviewGuidance, reviewStage, sentence, showChecks } from "./reviewState";

const CHECK_ICONS: Record<CheckState, LucideIcon> = { passing: CircleCheck, failing: CircleX, pending: CircleDashed, none: CircleMinus, unknown: CircleHelp };
const TONE_CLASS = { ok: "text-ok", danger: "text-danger", warn: "text-warn", muted: "text-ink-faint" } as const;

// A Card in Review: what it is waiting on, its CI, and the three things a Member can do about it.
// Approval is bound to the head shown here: Approve sends it back, and the server refuses if the
// pull request has moved on, a Session is still at work, or checks are failing and the Admin has
// not chosen to merge anyway. An Approval GitHub refused for a reason of its own still stands, so
// the block offers to try the merge again instead of asking for a second sign-off.
export function ReviewBlock({
  slug,
  card,
  agentName,
  approvals,
  members,
  isAdmin,
  onRequestChanges,
}: {
  slug: string;
  card: Card;
  agentName: string;
  approvals: Approval[];
  members: Map<string, Person>;
  isAdmin: boolean;
  onRequestChanges: () => void;
}) {
  const reduce = useReducedMotion();
  const approve = useApproveCard(slug);
  const retry = useRetryMerge(slug);
  const move = useMoveCard(slug);
  const sync = useSyncCard(slug);
  const [confirming, setConfirming] = useState<"approve" | "retry" | "close" | null>(null);

  // What GitHub says now, rather than when the poll last asked: once per Card as the block opens.
  const synced = useRef<string | null>(null);
  const syncCard = sync.mutate;
  const hasPr = Boolean(card.prNumber);
  useEffect(() => {
    if (!hasPr || synced.current === card.id) return;
    synced.current = card.id;
    syncCard(card.id);
  }, [card.id, hasPr, syncCard]);

  const stage = reviewStage(card, approvals);
  const checks = currentChecks(card);
  const gate = approveGate(checks, isAdmin);
  const working = Boolean(card.activeSession);
  const approverOf = (a: Approval) => members.get(a.userId)?.name ?? "a member";

  const error = move.error
    ? `The card was not closed. ${move.error.message}`
    : stage.kind === "refused"
      ? (retry.error?.message ?? null)
      : stage.kind === "approved"
        ? null
        : (approve.error?.message ?? null);

  const runApprove = () => approve.mutate({ id: card.id, headSha: card.prHeadSha, overrideChecks: gate.override || undefined });
  const runRetry = () => retry.mutate({ id: card.id, overrideChecks: gate.override || undefined });
  const confirm = () => {
    const what = confirming;
    setConfirming(null);
    if (what === "approve") runApprove();
    else if (what === "retry") runRetry();
    else if (what === "close") move.mutate({ id: card.id, column: "done", position: Number.MAX_SAFE_INTEGER / 2, revision: card.revision });
  };

  const secondary = (
    <>
      <Button variant="secondary" icon={<MessageSquarePlus className="size-4" strokeWidth={1.75} />} onClick={onRequestChanges}>
        Request changes
      </Button>
      <Button variant="ghost" className="ml-auto" loading={move.isPending} icon={<Archive className="size-4" strokeWidth={1.75} />} onClick={() => setConfirming("close")}>
        Close
      </Button>
    </>
  );

  let body: ReactNode;
  if (stage.kind === "approved") {
    body = (
      <div className="flex items-center gap-2 text-[13px]">
        <Check className="size-4 text-ok" strokeWidth={2} />
        <span className="text-ink">
          Approved by {approverOf(stage.approval)} {relativeTime(stage.approval.createdAt)}. {agentName} will merge it.
        </span>
      </div>
    );
  } else if (stage.kind === "refused") {
    body = (
      <>
        <Heading>The merge didn't go through</Heading>
        <Text>
          {sentence(stage.approval.mergeError ?? "")} Approved by {approverOf(stage.approval)} {relativeTime(stage.approval.createdAt)}; that approval still stands, so nobody has to approve again.
        </Text>
        {showChecks(checks, isAdmin) ? <ChecksLine checks={checks} prUrl={card.prUrl} reduce={Boolean(reduce)} /> : null}
        {gate.reason ? <Text>{gate.reason}</Text> : null}
        <Actions>
          <Button
            variant="primary"
            loading={retry.isPending}
            disabled={working || gate.blocked}
            icon={<RotateCcw className="size-4" strokeWidth={2} />}
            onClick={() => (gate.override ? setConfirming("retry") : runRetry())}
          >
            Try merging again
          </Button>
          {secondary}
        </Actions>
      </>
    );
  } else {
    const heading = stage.kind === "working" ? `${agentName} is still working on this` : stage.kind === "no_pr" ? "Nothing to approve yet" : "Ready for your review";
    const text =
      stage.kind === "working"
        ? "You can approve once the session has finished."
        : stage.kind === "no_pr"
          ? `There's no pull request on this card, so there is nothing to merge. Ask ${agentName} for what's missing, or close the card.`
          : reviewGuidance(card);
    body = (
      <>
        <Heading>{heading}</Heading>
        <Text>
          {text}
          {stage.kind === "ready" && card.prHeadSha ? (
            <>
              {" "}
              Approving merges{" "}
              <code className="rounded-[4px] bg-overlay px-1 py-px font-mono text-[11.5px] text-ink" title={card.prHeadSha}>
                {card.prHeadSha.slice(0, 7)}
              </code>
              {card.prBaseRef ? ` into ${card.prBaseRef}.` : "."}
            </>
          ) : null}
        </Text>
        {stage.kind !== "no_pr" && showChecks(checks, isAdmin) ? <ChecksLine checks={checks} prUrl={card.prUrl} reduce={Boolean(reduce)} /> : null}
        {stage.kind === "ready" && gate.reason ? <Text>{gate.reason}</Text> : null}
        <Actions>
          <Button
            variant="primary"
            loading={approve.isPending}
            disabled={stage.kind !== "ready" || gate.blocked}
            icon={<Check className="size-4" strokeWidth={2} />}
            onClick={() => setConfirming("approve")}
          >
            Approve
          </Button>
          {secondary}
        </Actions>
      </>
    );
  }

  return (
    <div className={cx("mx-6 mt-4 rounded-card border bg-raised px-4 py-3.5 transition-colors duration-300", stage.kind === "refused" ? "border-warn/30" : "border-line")}>
      <motion.div key={stage.kind} initial={reduce ? false : { opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}>
        {body}
      </motion.div>
      <AnimatePresence initial={false}>
        {error ? (
          <motion.p
            key="review-error"
            role="alert"
            initial={reduce ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="mt-3 border-t border-line pt-2.5 text-[12.5px] text-danger"
          >
            {error}
          </motion.p>
        ) : null}
      </AnimatePresence>

      <Dialog open={confirming === "approve" || confirming === "retry"} onClose={() => setConfirming(null)} title={confirming === "retry" ? "Merge it anyway?" : "Approve and merge?"} width={460}>
        <p className="text-[13.5px] leading-relaxed text-ink-muted">{mergeStatement(card)}</p>
        {gate.warning ? (
          <p className={cx("mt-3 flex items-start gap-2 rounded-card border px-3 py-2.5 text-[13px] leading-snug", gate.override ? "border-danger/30 text-danger" : "border-warn/30 text-warn")}>
            <TriangleAlert className="mt-px size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            {gate.warning}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" autoFocus onClick={() => setConfirming(null)}>
            Cancel
          </Button>
          <Button variant={gate.override ? "danger" : "primary"} icon={<Check className="size-4" strokeWidth={2} />} onClick={confirm}>
            {gate.override ? "Merge anyway" : "Approve and merge"}
          </Button>
        </div>
      </Dialog>

      <Dialog open={confirming === "close"} onClose={() => setConfirming(null)} title="Close this card?" width={460}>
        <p className="text-[13.5px] leading-relaxed text-ink-muted">{closeStatement(card, agentName)}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" autoFocus onClick={() => setConfirming(null)}>
            Cancel
          </Button>
          <Button variant="danger" icon={<Archive className="size-4" strokeWidth={1.75} />} onClick={confirm}>
            Close card
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <p className="text-[13.5px] font-medium text-ink">{children}</p>;
}

function Text({ children }: { children: ReactNode }) {
  return <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-muted">{children}</p>;
}

function Actions({ children }: { children: ReactNode }) {
  return <div className="mt-3.5 flex flex-wrap items-center gap-2">{children}</div>;
}

// One line of CI: how the checks on the shown head went, and where to see them on GitHub. A run
// still going turns slowly, which is the only motion here that means anything.
function ChecksLine({ checks, prUrl, reduce }: { checks: ChecksSummary; prUrl: string | null; reduce: boolean }) {
  const Icon = CHECK_ICONS[checks.state];
  const url = checksPageUrl(prUrl);
  return (
    <AnimatePresence mode="wait" initial={false}>
      <motion.p
        key={`${checks.state}-${checks.total}-${checks.failed}-${checks.pending}`}
        initial={reduce ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        transition={{ duration: 0.16 }}
        className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[12.5px] text-ink-muted"
      >
        <Icon
          className={cx("size-3.5 shrink-0", TONE_CLASS[CHECK_TONES[checks.state]], checks.state === "pending" && "motion-safe:animate-[spin_4s_linear_infinite]")}
          strokeWidth={2}
          aria-hidden="true"
        />
        <span className={checks.state === "failing" ? "text-ink" : undefined}>{describeChecks(checks)}</span>
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" aria-label="See the checks on GitHub" className="inline-flex items-center gap-0.5 text-ink-faint no-underline transition-colors hover:text-accent">
            Details
            <ArrowUpRight className="size-3" strokeWidth={1.75} />
          </a>
        ) : null}
      </motion.p>
    </AnimatePresence>
  );
}
