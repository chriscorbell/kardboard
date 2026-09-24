import { useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Archive, ArrowUpRight, Check, CircleCheck, CircleDashed, CircleHelp, CircleMinus, CircleX, GitCommitHorizontal, MessageSquarePlus, RotateCcw, TriangleAlert, type LucideIcon } from "lucide-react";
import { describeChecks, type Approval, type Card, type CheckState, type ChecksSummary, type Person } from "@kardboard/shared";
import { Button, cx } from "../../components/ui";
import { Dialog } from "../../components/Dialog";
import { relativeTime } from "../../lib/format";
import { useApproveCard, useMoveCard, useRetryMerge, useSyncCard } from "../../lib/api";
import {
  approveGate,
  CHECK_TONES,
  checksPageUrl,
  checksUnreadable,
  closeStatement,
  compareUrl,
  currentChecks,
  followPin,
  headMove,
  mergeStatement,
  repin,
  retryHold,
  reviewGuidance,
  reviewStage,
  sentence,
  shortSha,
  showChecks,
  SKIP_CHECKS_WARNING,
  type HeadMove,
  type ReviewPin,
} from "./reviewState";

const CHECK_ICONS: Record<CheckState, LucideIcon> = { passing: CircleCheck, failing: CircleX, pending: CircleDashed, none: CircleMinus, unknown: CircleHelp };
const TONE_CLASS = { ok: "text-ok", danger: "text-danger", warn: "text-warn", muted: "text-ink-faint" } as const;

// A Card in Review: what it is waiting on, its CI, and the three things a Member can do about it.
// Approval is bound to the head the Member is looking at, pinned once the block has read the Card
// from GitHub: Approve sends that head, never whatever the Card shows at the click, and a push while
// the block is open has to be looked at before Approve works again. The server refuses too if the
// pull request has moved on, the Agent has work on the Card still to start or finish, or checks are
// failing or unreadable and the Admin has not chosen to merge anyway. An Approval GitHub refused for
// a reason of its own still stands, so the block offers to try the merge again instead of asking for
// a second sign-off.
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
  // The Admin chose to merge without the checks GitHub did not show.
  const [skipChecks, setSkipChecks] = useState(false);

  // What GitHub says now, rather than when the poll last asked: once per Card as the block opens.
  const synced = useRef<string | null>(null);
  const syncCard = sync.mutate;
  const hasPr = Boolean(card.prNumber);
  useEffect(() => {
    if (!hasPr || synced.current === card.id) return;
    synced.current = card.id;
    syncCard(card.id);
  }, [card.id, hasPr, syncCard]);

  // The head the Member is looking at. Kept in state as a render-time update, so it is in place
  // before anything could send it.
  const readSettled = !hasPr || (sync.variables === card.id && (sync.isSuccess || sync.isError));
  const [storedPin, setStoredPin] = useState<ReviewPin | null>(null);
  const pin = followPin(storedPin, card, readSettled);
  if (pin !== storedPin) setStoredPin(pin);
  const moved = headMove(pin, card);

  // A confirmation names the head it merges, so one open when the head moves is shut rather than
  // left to merge something else.
  const movedTo = moved?.to ?? null;
  useEffect(() => {
    if (movedTo) setConfirming((c) => (c === "approve" || c === "retry" ? null : c));
  }, [movedTo]);

  const stage = reviewStage(card, approvals);
  const checks = currentChecks(card);
  const gate = approveGate(checks, isAdmin);
  const hold = retryHold(card, agentName);
  const approverOf = (a: Approval) => members.get(a.userId)?.name ?? "a member";
  // The Admin can merge past checks GitHub did not show, once a merge was refused for that.
  const canSkipChecks = isAdmin && checksUnreadable(stage.kind === "refused" ? retry.error : approve.error);
  const override = gate.override || skipChecks;

  const error = move.error
    ? `The card was not closed. ${move.error.message}`
    : stage.kind === "refused"
      ? (retry.error?.message ?? null)
      : stage.kind === "approved"
        ? null
        : (approve.error?.message ?? null);

  const runApprove = () => approve.mutate({ id: card.id, headSha: pin.sha, overrideChecks: override || undefined });
  const runRetry = () => retry.mutate({ id: card.id, overrideChecks: override || undefined });
  const ask = (what: "approve" | "retry", skipping: boolean) => {
    setSkipChecks(skipping);
    setConfirming(what);
  };
  const confirm = () => {
    const what = confirming;
    setConfirming(null);
    if (what === "approve") runApprove();
    else if (what === "retry") runRetry();
    else if (what === "close") move.mutate({ id: card.id, column: "done", position: Number.MAX_SAFE_INTEGER / 2, revision: card.revision });
  };
  const lookAgain = () => {
    setStoredPin(repin(card));
    approve.reset();
    retry.reset();
  };
  const skipButton = canSkipChecks ? (
    <Button variant="danger" onClick={() => ask(stage.kind === "refused" ? "retry" : "approve", true)}>
      Merge without checks
    </Button>
  ) : null;

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
  } else if (moved && (stage.kind === "ready" || stage.kind === "refused")) {
    body = <MovedOn move={moved} prNumber={card.prNumber} prUrl={card.prUrl} onLook={lookAgain} secondary={secondary} />;
  } else if (stage.kind === "refused") {
    body = (
      <>
        <Heading>The merge didn't go through</Heading>
        <Text>
          {sentence(stage.approval.mergeError ?? "")} Approved by {approverOf(stage.approval)} {relativeTime(stage.approval.createdAt)}; that approval still stands, so nobody has to approve again.
        </Text>
        {showChecks(checks, isAdmin) ? <ChecksLine checks={checks} prUrl={card.prUrl} reduce={Boolean(reduce)} /> : null}
        {hold ? <Text>{hold}</Text> : gate.reason ? <Text>{gate.reason}</Text> : null}
        <Actions>
          <Button
            variant="primary"
            loading={retry.isPending}
            disabled={Boolean(hold) || gate.blocked}
            icon={<RotateCcw className="size-4" strokeWidth={2} />}
            onClick={() => (gate.override ? ask("retry", false) : runRetry())}
          >
            Try merging again
          </Button>
          {hold ? null : skipButton}
          {secondary}
        </Actions>
      </>
    );
  } else {
    const heading =
      stage.kind === "working" ? `${agentName} is still working on this` : stage.kind === "waiting" ? `Waiting for ${agentName}` : stage.kind === "no_pr" ? "Nothing to approve yet" : "Ready for your review";
    const text =
      stage.kind === "working"
        ? "You can approve once the session has finished."
        : stage.kind === "waiting"
          ? `${agentName} hasn't read the latest comment or change yet. You can approve once it has.`
          : stage.kind === "no_pr"
            ? `There's no pull request on this card, so there is nothing to merge. Ask ${agentName} for what's missing, or close the card.`
            : reviewGuidance(card);
    body = (
      <>
        <Heading>{heading}</Heading>
        <Text>
          {text}
          {stage.kind === "ready" && pin.sha ? (
            <>
              {" "}
              Approving merges <Sha sha={pin.sha} />
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
            onClick={() => ask("approve", false)}
          >
            Approve
          </Button>
          {stage.kind === "ready" ? skipButton : null}
          {secondary}
        </Actions>
      </>
    );
  }

  return (
    <div className={cx("mx-6 mt-4 rounded-card border bg-raised px-4 py-3.5 transition-colors duration-300", stage.kind === "refused" || moved ? "border-warn/30" : "border-line")}>
      <motion.div key={moved ? "moved" : stage.kind} initial={reduce ? false : { opacity: 0, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}>
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
        <p className="text-[13.5px] leading-relaxed text-ink-muted">{mergeStatement({ ...card, prHeadSha: pin.sha })}</p>
        {skipChecks || gate.warning ? (
          <p className={cx("mt-3 flex items-start gap-2 rounded-card border px-3 py-2.5 text-[13px] leading-snug", override ? "border-danger/30 text-danger" : "border-warn/30 text-warn")}>
            <TriangleAlert className="mt-px size-4 shrink-0" strokeWidth={1.75} aria-hidden="true" />
            {skipChecks ? SKIP_CHECKS_WARNING : gate.warning}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" autoFocus onClick={() => setConfirming(null)}>
            Cancel
          </Button>
          <Button variant={override ? "danger" : "primary"} icon={<Check className="size-4" strokeWidth={2} />} onClick={confirm}>
            {override ? "Merge anyway" : "Approve and merge"}
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

function Sha({ sha }: { sha: string }) {
  return (
    <code className="rounded-[4px] bg-overlay px-1 py-px font-mono text-[11.5px] text-ink" title={sha}>
      {shortSha(sha)}
    </code>
  );
}

// The pull request moved on while the Member had the block open. What they were looking at is no
// longer what would merge, so Approve waits until they choose to look at the new commit.
function MovedOn({ move, prNumber, prUrl, onLook, secondary }: { move: HeadMove; prNumber: number | null; prUrl: string | null; onLook: () => void; secondary: ReactNode }) {
  const url = compareUrl(prUrl, move);
  return (
    <>
      <Heading>New commits since you started looking</Heading>
      <Text>
        {prNumber ? `Pull request #${prNumber}` : "The pull request"} moved from <Sha sha={move.from} /> to <Sha sha={move.to} />. Look at the new commit before approving.
        {url ? (
          <>
            {" "}
            <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-0.5 text-ink-faint no-underline transition-colors hover:text-accent">
              What changed
              <ArrowUpRight className="size-3" strokeWidth={1.75} />
            </a>
          </>
        ) : null}
      </Text>
      <Actions>
        <Button variant="primary" icon={<GitCommitHorizontal className="size-4" strokeWidth={2} />} onClick={onLook}>
          Look at the new commit
        </Button>
        {secondary}
      </Actions>
    </>
  );
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
