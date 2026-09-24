import { useEffect, useId, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, Check, ChevronDown, ExternalLink, GitBranch, GitPullRequest, History, Pencil, RotateCcw, Square, X } from "lucide-react";
import { approvalAwaitingRetry, COLUMNS, COLUMN_LABELS, PRIORITIES, type ActivityEntry, type AgentProfile, type Approval, type BoardView, type Card, type Column, type Comment, type Priority, type User } from "@kardboard/shared";
import { useApproveCard, useCard, useCreateComment, useMe, useMoveCard, useRetryMerge, useUpdateCard, useUpdateComment, request, keys } from "../../lib/api";
import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router";
import { Avatar, Button, Chip, cx, ErrorState, IconButton, Input, Skeleton, Textarea } from "../../components/ui";
import { Menu } from "../../components/Menu";
import { Markdown } from "../../components/Markdown";
import { absoluteTime, relativeTime, shortId } from "../../lib/format";
import { Composer } from "./Composer";
import { COLUMN_TONES } from "./columns";
import { WorkingDot } from "./CardTile";
import { ApiError } from "../../lib/errors";
import { AttachmentView } from "./AttachmentView";
import { EditConflict, resolveRefusedSave, type EditableField, type EditBase } from "./cardEdits";
import { useModalFocus } from "../../components/focus";

const PRIORITY_LABELS: Record<Priority, string> = { none: "No priority", low: "Low", medium: "Medium", high: "High" };

export function CardSheet({ slug, cardId, view, onClose }: { slug: string; cardId: string | null; view: BoardView; onClose: () => void }) {
  const reduce = useReducedMotion();
  const sheet = useRef<HTMLElement>(null);
  const titleId = useId();
  // The sheet is long, so it takes focus itself and is announced by the card's title first.
  useModalFocus(sheet, Boolean(cardId), { initial: "container", resetKey: cardId });
  useEffect(() => {
    if (!cardId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cardId, onClose]);
  return (
    <AnimatePresence>
      {cardId ? (
        <motion.div key="sheet-root" className="fixed inset-0 z-40" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
          <div className="absolute inset-0 bg-bg/50" onClick={onClose} />
          <motion.aside
            ref={sheet}
            key={cardId}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            tabIndex={-1}
            initial={reduce ? false : { x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ duration: 0.26, ease: [0.16, 1, 0.3, 1] }}
            className="absolute inset-y-0 right-0 flex w-full max-w-[680px] flex-col border-l border-line-strong bg-surface shadow-[-24px_0_64px_-24px_rgba(0,0,0,0.7)] focus:outline-none"
            aria-label="Card"
          >
            <SheetBody slug={slug} cardId={cardId} titleId={titleId} view={view} onClose={onClose} />
          </motion.aside>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

function SheetBody({ slug, cardId, titleId, view, onClose }: { slug: string; cardId: string; titleId: string; view: BoardView; onClose: () => void }) {
  const me = useMe();
  const detail = useCard(cardId);
  const update = useUpdateCard(slug);
  const move = useMoveCard(slug);
  const approve = useApproveCard(slug);
  const retryMerge = useRetryMerge(slug);
  const qc = useQueryClient();
  const members = useMemo(() => new Map(view.members.map((m) => [m.id, m])), [view.members]);
  const handles = useMemo(() => {
    const m = new Map(view.members.map((u) => [u.handle, u.name]));
    m.set(view.agent.name.toLowerCase(), view.agent.name);
    return m;
  }, [view.members, view.agent.name]);
  const card = detail.data?.card ?? view.cards.find((c) => c.id === cardId);
  const isAdmin = me.data?.user.role === "admin";

  if (!card) {
    if (detail.isError) {
      const gone = detail.error instanceof ApiError && (detail.error.status === 404 || detail.error.status === 403);
      return (
        <>
          <div className="flex h-12 shrink-0 items-center justify-end border-b border-line px-4">
            <IconButton label="Close" onClick={onClose}>
              <X className="size-4" strokeWidth={1.75} />
            </IconButton>
          </div>
          <div className="p-6">
            {gone ? (
              <p className="text-sm text-ink-muted">This card does not exist, or it is on a board you cannot open.</p>
            ) : (
              <ErrorState compact title="Could not load this card." error={detail.error} onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
            )}
          </div>
        </>
      );
    }
    return (
      <div className="flex flex-1 flex-col gap-3 p-6">
        <Skeleton className="h-6 w-2/3" />
        <Skeleton className="h-24" />
      </div>
    );
  }
  const session = card.activeSession;

  // Saves an edit against the revision it started from, so a change made meanwhile is caught.
  const saveField = async (field: EditableField, value: string, base: EditBase) => {
    const save = (revision: number) => update.mutateAsync({ id: card.id, [field]: value, revision });
    try {
      await save(base.revision);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 409)) throw err;
      const next = resolveRefusedSave(field, base, (err.data as { card?: Card } | null)?.card);
      if (!next) throw err;
      if ("conflict" in next) throw new EditConflict(next.conflict);
      await save(next.retryAt);
    }
  };

  return (
    <>
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-line px-4">
        <Menu
          trigger={
            <button className="inline-flex items-center gap-1 rounded-full">
              <Chip tone={COLUMN_TONES[card.column]}>
                {COLUMN_LABELS[card.column]}
                <ChevronDown className="size-3" strokeWidth={2} />
              </Chip>
            </button>
          }
          items={COLUMNS.map((c) => ({ label: COLUMN_LABELS[c], active: c === card.column, onSelect: () => c !== card.column && move.mutate({ id: card.id, column: c, position: Number.MAX_SAFE_INTEGER / 2, revision: card.revision }) }))}
        />
        <span className="font-mono text-[11.5px] text-ink-faint">{shortId(card.id)}</span>
        <span className="ml-auto" />
        <Menu
          align="right"
          trigger={
            <button className="inline-flex h-7 items-center gap-1 rounded-control px-2 text-[12.5px] text-ink-muted hover:bg-raised hover:text-ink">
              {PRIORITY_LABELS[card.priority]}
              <ChevronDown className="size-3.5" strokeWidth={1.75} />
            </button>
          }
          items={PRIORITIES.map((p) => ({ label: PRIORITY_LABELS[p], active: p === card.priority, onSelect: () => p !== card.priority && update.mutate({ id: card.id, priority: p, revision: card.revision }) }))}
        />
        <IconButton label="Close" onClick={onClose}>
          <X className="size-4" strokeWidth={1.75} />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-6 pt-5">
          <TitleEditor card={card} labelId={titleId} onSave={(title, base) => saveField("title", title, base)} />
          <p className="mt-1.5 text-[12px] text-ink-faint">
            Opened {relativeTime(card.createdAt)} by {card.creatorKind === "agent" ? view.agent.name : (card.creatorId && members.get(card.creatorId)?.name) || "someone"}
            {card.parentCardId ? <> as part of a larger request</> : null}
          </p>
        </div>

        {session || card.pendingRerun ? (
          <div className="mx-6 mt-4 rounded-card border border-accent/25 bg-accent-soft px-3.5 py-3">
            {session ? (
              <div className="flex items-start gap-2.5">
                <WorkingDot className="mt-1.5" />
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] font-medium text-accent">
                    {view.agent.name} {session.status === "queued" ? "is starting a session" : "is working on this"}
                    {session.startedAt ? <span className="font-normal text-accent/70"> since {relativeTime(session.startedAt)}</span> : null}
                  </p>
                  {session.intent ? <p className="mt-0.5 text-[13px] text-ink-muted">{session.intent}</p> : null}
                  {card.pendingRerun ? <p className="mt-1 text-[12px] text-ink-faint">Your latest changes are queued for the next session.</p> : null}
                </div>
                {isAdmin ? (
                  <span className="flex shrink-0 gap-1">
                    <Button size="sm" variant="ghost" icon={<Square className="size-3.5" strokeWidth={2} />} onClick={() => void cancelSession(session.id, false, qc, slug, card.id)}>
                      Cancel
                    </Button>
                    <Button size="sm" variant="ghost" icon={<RotateCcw className="size-3.5" strokeWidth={2} />} onClick={() => void cancelSession(session.id, true, qc, slug, card.id)}>
                      Re-run
                    </Button>
                  </span>
                ) : null}
              </div>
            ) : (
              <p className="text-[13px] text-ink-muted">Changes are queued. {view.agent.name} will pick them up in the next session.</p>
            )}
          </div>
        ) : null}

        <div className="px-6 pt-5">
          <DescriptionEditor card={card} handles={handles} onSave={(description, base) => saveField("description", description, base)} />
        </div>

        {card.branch || card.prUrl || card.previewUrl ? (
          <div className="mx-6 mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 rounded-card border border-line bg-bg px-3.5 py-2.5 text-[12.5px]">
            {card.branch ? (
              <span className="inline-flex items-center gap-1.5 font-mono text-ink-muted">
                <GitBranch className="size-3.5" strokeWidth={1.75} />
                {card.branch}
              </span>
            ) : null}
            {card.prUrl ? (
              <a href={card.prUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-ink no-underline hover:text-accent">
                <GitPullRequest className="size-3.5" strokeWidth={1.75} />
                Pull request {card.prNumber ? `#${card.prNumber}` : ""}
                <ArrowUpRight className="size-3" strokeWidth={1.75} />
              </a>
            ) : null}
            {card.previewUrl ? (
              <a href={card.previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-ink no-underline hover:text-accent">
                <ExternalLink className="size-3.5" strokeWidth={1.75} />
                Open preview
              </a>
            ) : null}
          </div>
        ) : null}

        {card.column === "review" ? (
          <ReviewBlock
            card={card}
            agentName={view.agent.name}
            approvals={detail.data?.approvals ?? []}
            members={members}
            onApprove={() => approve.mutate({ id: card.id, headSha: card.prHeadSha })}
            busy={approve.isPending}
            error={approve.error?.message ?? null}
            onRetryMerge={() => retryMerge.mutate(card.id)}
            retrying={retryMerge.isPending}
            retryError={retryMerge.error?.message ?? null}
          />
        ) : null}

        {detail.data?.children.length ? <ChildCards slug={slug} cards={detail.data.children} agentName={view.agent.name} /> : null}

        <div className="px-6 pb-2 pt-6">
          <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-ink-faint">Comments</h3>
          {detail.isPending ? (
            <Skeleton className="h-16" />
          ) : !detail.data ? (
            <ErrorState compact title="Could not load comments." error={detail.error} onRetry={() => void detail.refetch()} retrying={detail.isFetching} />
          ) : (
            <CommentList comments={detail.data.comments} members={members} agent={view.agent} handles={handles} meId={me.data?.user.id ?? ""} cardId={card.id} />
          )}
        </div>
        <div className="px-6 pb-4">
          <NewComment cardId={card.id} members={view.members} agent={view.agent} />
        </div>
        <Activity entries={detail.data?.activity ?? []} members={members} agentName={view.agent.name} />
      </div>
    </>
  );
}

// The pieces a session split this request into. They run on their own, so this is where a person
// sees how far the whole request has got without opening each child in turn.
function ChildCards({ slug, cards, agentName }: { slug: string; cards: Card[]; agentName: string }) {
  const navigate = useNavigate();
  const open = cards.filter((c) => c.column !== "done").length;
  return (
    <div className="px-6 pt-6">
      <h3 className="mb-3 text-[12px] font-semibold uppercase tracking-wide text-ink-faint">Pieces of this request</h3>
      <ul className="flex list-none flex-col gap-1.5 p-0">
        {cards.map((c) => (
          <li key={c.id}>
            <button
              type="button"
              onClick={() => navigate(`/b/${slug}/c/${c.id}`)}
              className="flex w-full items-center gap-2 rounded-card border border-line bg-bg px-3 py-2 text-left text-[13px] text-ink transition-colors hover:border-line-strong"
            >
              <span className="min-w-0 flex-1 truncate">{c.title}</span>
              {c.activeSession ? <WorkingDot /> : null}
              <Chip tone={c.column === "done" && c.outcome === "closed" ? "neutral" : COLUMN_TONES[c.column]}>
                {c.column === "done" ? (c.outcome === "closed" ? "Closed" : "Merged") : COLUMN_LABELS[c.column]}
              </Chip>
            </button>
          </li>
        ))}
      </ul>
      <p className="mt-2 text-[12px] text-ink-faint">
        {open === 0 ? `Every piece is finished, so ${agentName} picks this card up again.` : `${open} of ${cards.length} still open. This card waits until the last one is done.`}
      </p>
    </div>
  );
}

async function cancelSession(id: string, rerun: boolean, qc: ReturnType<typeof useQueryClient>, slug: string, cardId: string) {
  await request(`/admin/sessions/${id}/cancel${rerun ? "?rerun=1" : ""}`, { method: "POST" });
  await qc.invalidateQueries({ queryKey: keys.board(slug) });
  await qc.invalidateQueries({ queryKey: keys.card(cardId) });
}

function TitleEditor({ card, labelId, onSave }: { card: Card; labelId: string; onSave: (title: string, base: EditBase) => Promise<void> }) {
  const [draft, setDraft] = useState<{ value: string; base: EditBase } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const saving = useRef(false);
  const refocus = useRef(false);
  const button = useRef<HTMLButtonElement>(null);
  const errorId = useId();
  useEffect(() => {
    if (draft || !refocus.current) return;
    refocus.current = false;
    button.current?.focus();
  }, [draft]);

  if (!draft) {
    return (
      <h1 className="text-[19px] font-semibold leading-snug tracking-tight text-ink">
        <button
          ref={button}
          type="button"
          onClick={() => {
            setDraft({ value: card.title, base: { revision: card.revision, value: card.title } });
            setError(null);
          }}
          className="group flex w-full cursor-text items-start gap-2 rounded-[4px] text-left"
          title="Edit title"
        >
          <span id={labelId}>{card.title}</span>
          <Pencil className="mt-1.5 size-3.5 shrink-0 text-ink-faint opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100 [@media(hover:none)]:opacity-100" strokeWidth={1.75} aria-hidden="true" />
          <span className="sr-only">Edit title</span>
        </button>
      </h1>
    );
  }
  const close = (focusTitle: boolean) => {
    refocus.current = focusTitle;
    setDraft(null);
    setError(null);
  };
  // The editor stays open until the title is saved, so a refused save loses nothing.
  const commit = async (focusTitle: boolean) => {
    if (saving.current) return;
    const next = draft.value.trim();
    if (!next || next === draft.base.value) return close(focusTitle);
    saving.current = true;
    try {
      await onSave(next, draft.base);
      close(focusTitle);
    } catch (err) {
      if (err instanceof EditConflict) {
        // Their title is now the base, so saving again replaces it on purpose.
        setDraft((d) => d && { ...d, base: { revision: err.card.revision, value: err.card.title } });
        setError(`Someone else renamed this card to “${err.card.title}” while you were editing. Press Enter to use yours, or Escape to keep theirs.`);
      } else {
        setError(`The title was not saved. ${(err as Error).message}`);
      }
    } finally {
      saving.current = false;
    }
  };
  return (
    <div>
      <Input
        autoFocus
        value={draft.value}
        onChange={(e) => setDraft({ ...draft, value: e.target.value })}
        // A click elsewhere saves, unless the last save failed: then only Enter retries.
        onBlur={() => {
          if (!error) void commit(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.nativeEvent.isComposing) void commit(true);
          if (e.key === "Escape") close(true);
        }}
        aria-label="Title"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        className="h-10 text-[19px] font-semibold tracking-tight"
        maxLength={200}
      />
      {error ? (
        <p id={errorId} role="alert" className="mt-1.5 text-[12px] text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function DescriptionEditor({ card, handles, onSave }: { card: Card; handles: Map<string, string>; onSave: (d: string, base: EditBase) => Promise<void> }) {
  const [draft, setDraft] = useState<{ value: string; base: EditBase } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();
  if (draft) {
    const close = () => {
      setDraft(null);
      setError(null);
    };
    const save = async () => {
      if (draft.value === draft.base.value) return close();
      setBusy(true);
      try {
        await onSave(draft.value, draft.base);
        close();
      } catch (err) {
        if (err instanceof EditConflict) {
          setDraft((d) => d && { ...d, base: { revision: err.card.revision, value: err.card.description } });
          setError("Someone else changed these details while you were writing. Save again to replace their version with yours, or cancel to see theirs.");
        } else {
          setError(`Your changes were not saved. ${(err as Error).message}`);
        }
      } finally {
        setBusy(false);
      }
    };
    return (
      <div>
        <Textarea
          autoFocus
          value={draft.value}
          onChange={(e) => setDraft({ ...draft, value: e.target.value })}
          rows={8}
          onKeyDown={(e) => e.key === "Escape" && close()}
          aria-label="Details"
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
        />
        {error ? (
          <p id={errorId} role="alert" className="mt-2 text-[12px] text-danger">
            {error}
          </p>
        ) : null}
        <div className="mt-2 flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button size="sm" variant="primary" loading={busy} onClick={() => void save()}>
            Save
          </Button>
        </div>
      </div>
    );
  }
  return (
    <div className="group relative">
      {card.description.trim() ? (
        <Markdown body={card.description} handles={handles} />
      ) : (
        <p className="text-[13px] italic text-ink-faint">No details yet.</p>
      )}
      <button
        type="button"
        onClick={() => {
          setDraft({ value: card.description, base: { revision: card.revision, value: card.description } });
          setError(null);
        }}
        className="mt-2 inline-flex items-center gap-1 text-[12px] text-ink-faint transition-colors hover:text-ink"
      >
        <Pencil className="size-3" strokeWidth={1.75} />
        Edit details
      </button>
    </div>
  );
}

// Approval is bound to the revision shown here: the short SHA is what Approve sends back, and the
// server refuses it if the pull request has moved on or a Session is still at work. An Approval
// GitHub refused to merge for a reason of its own still stands, so the block offers Retry merge.
function ReviewBlock({
  card,
  agentName,
  approvals,
  members,
  onApprove,
  busy,
  error,
  onRetryMerge,
  retrying,
  retryError,
}: {
  card: Card;
  agentName: string;
  approvals: Approval[];
  members: Map<string, User>;
  onApprove: () => void;
  busy: boolean;
  error: string | null;
  onRetryMerge: () => void;
  retrying: boolean;
  retryError: string | null;
}) {
  const reduce = useReducedMotion();
  const live = approvals.filter((a) => !a.invalidatedAt);
  const refused = approvalAwaitingRetry(approvals);
  const working = Boolean(card.activeSession);
  const shown = refused ? retryError : live.length === 0 ? error : null;
  return (
    <div className="mx-6 mt-4 rounded-card border border-line bg-raised px-4 py-3.5">
      {refused ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium text-ink">GitHub refused the merge</p>
            <p className="mt-0.5 text-[12.5px] text-ink-muted">
              {refused.mergeError} The approval by {members.get(refused.userId)?.name ?? "a member"} {relativeTime(refused.createdAt)} still stands, so try again once the cause is fixed.
            </p>
          </div>
          <Button variant="primary" className="w-full sm:w-auto" loading={retrying} disabled={working} icon={<RotateCcw className="size-4" strokeWidth={2} />} onClick={onRetryMerge}>
            Retry merge
          </Button>
        </div>
      ) : live.length > 0 ? (
        <div className="flex items-center gap-2 text-[13px]">
          <Check className="size-4 text-ok" strokeWidth={2} />
          <span className="text-ink">
            Approved by {members.get(live[0]!.userId)?.name ?? "a member"} {relativeTime(live[0]!.createdAt)}. {agentName} will merge it.
          </span>
        </div>
      ) : (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium text-ink">Ready for your review</p>
            {working ? (
              <p className="mt-0.5 text-[12.5px] text-ink-muted">{agentName} is still working on this card. You can approve once the session has finished.</p>
            ) : (
              <p className="mt-0.5 text-[12.5px] text-ink-muted">
                Check the preview. Approving lets {agentName} merge {card.prNumber ? `pull request #${card.prNumber}` : "the change"}
                {card.prHeadSha ? (
                  <>
                    {" "}at <code className="rounded-[4px] bg-overlay px-1 py-px font-mono text-[11.5px] text-ink" title={card.prHeadSha}>{card.prHeadSha.slice(0, 7)}</code>
                  </>
                ) : null}{" "}
                and close this card. Ask for changes in a comment instead if it's not right.
              </p>
            )}
          </div>
          <Button variant="primary" className="w-full sm:w-auto" loading={busy} disabled={working} icon={<Check className="size-4" strokeWidth={2} />} onClick={onApprove}>
            Approve
          </Button>
        </div>
      )}
      <AnimatePresence initial={false}>
        {shown ? (
          <motion.p
            key="approve-error"
            role="alert"
            initial={reduce ? false : { opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className="mt-3 border-t border-line pt-2.5 text-[12.5px] text-danger"
          >
            {shown}
          </motion.p>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function CommentList({ comments, members, agent, handles, meId, cardId }: { comments: Comment[]; members: Map<string, User>; agent: AgentProfile; handles: Map<string, string>; meId: string; cardId: string }) {
  const agentName = agent.name;
  const [editingId, setEditingId] = useState<string | null>(null);
  const updateComment = useUpdateComment(cardId);
  if (comments.length === 0) return <p className="text-[13px] text-ink-faint">No comments yet.</p>;
  return (
    <ol className="flex flex-col gap-5">
      {comments.map((c) => {
        const author = c.authorKind === "agent" ? agent : c.authorId ? members.get(c.authorId) : undefined;
        const mine = c.authorKind === "user" && c.authorId === meId;
        return (
          <li key={c.id} className="flex gap-3">
            <Avatar name={author?.name ?? "Unknown"} url={author?.avatarUrl} size={26} tone={c.authorKind === "agent" ? "agent" : "neutral"} className="mt-0.5" />
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2 text-[12.5px]">
                <span className={cx("font-medium", c.authorKind === "agent" ? "text-accent" : "text-ink")}>{author?.name ?? "Unknown"}</span>
                <span className="text-ink-faint" title={absoluteTime(c.createdAt)}>
                  {relativeTime(c.createdAt)}
                </span>
                {c.editedAt ? <span className="text-ink-faint">edited</span> : null}
                {mine && editingId !== c.id ? (
                  <button
                    type="button"
                    aria-label="Edit comment"
                    className="ml-auto text-ink-faint opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 [li:hover_&]:opacity-100 [@media(hover:none)]:opacity-100"
                    onClick={() => setEditingId(c.id)}
                  >
                    Edit
                  </button>
                ) : null}
              </div>
              {editingId === c.id ? (
                <div className="mt-1.5">
                  <Composer
                    members={[...members.values()]}
                    agent={agent}
                    initialBody={c.body}
                    submitLabel="Save"
                    allowFiles={false}
                    autoFocus
                    onCancel={() => setEditingId(null)}
                    onSubmit={async (body) => {
                      await updateComment.mutateAsync({ id: c.id, body });
                      setEditingId(null);
                    }}
                  />
                </div>
              ) : (
                <div className="mt-1">
                  <Markdown body={c.body} handles={handles} />
                  {c.attachments.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-2">
                      {c.attachments.map((a) => (
                        <AttachmentView key={a.id} a={a} />
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function NewComment({ cardId, members, agent }: { cardId: string; members: User[]; agent: AgentProfile }) {
  const create = useCreateComment(cardId);
  return (
    <div className="mt-5 border-t border-line pt-4">
      <Composer members={members} agent={agent} onSubmit={(body, files) => create.mutateAsync({ body, files }).then(() => undefined)} />
    </div>
  );
}

const ACTIVITY_LABEL: Record<string, (p: Record<string, unknown>) => string> = {
  "card.created": () => "created this card",
  "card.edited": (p) => `edited the ${(p.fields as string[] | undefined)?.join(" and ") ?? "card"}`,
  "card.moved": (p) => `moved it from ${COLUMN_LABELS[p.from as Column] ?? p.from} to ${COLUMN_LABELS[p.to as Column] ?? p.to}`,
  "card.approved": () => "approved the change",
  "comment.posted": () => "commented",
  "comment.edited": () => "edited a comment",
  "session.queued": () => "queued a session",
  "session.started": () => "started a session",
  "session.succeeded": (p) => `finished a session${p.outcomeSummary ? `: ${p.outcomeSummary as string}` : ""}`,
  "session.failed": (p) => `session failed${p.outcomeSummary ? `: ${p.outcomeSummary as string}` : ""}`,
  "session.cancelled": () => "cancelled the session",
  "session.timed_out": () => "session hit its time limit",
  "session.cancel_requested": () => "asked to cancel the session",
};

function Activity({ entries, members, agentName }: { entries: ActivityEntry[]; members: Map<string, User>; agentName: string }) {
  const [open, setOpen] = useState(false);
  const visible = entries.filter((e) => e.type !== "comment.posted" && e.type !== "comment.edited");
  if (visible.length === 0) return null;
  return (
    <div className="border-t border-line px-6 py-4">
      <button type="button" onClick={() => setOpen((o) => !o)} className="inline-flex items-center gap-1.5 text-[12px] font-semibold uppercase tracking-wide text-ink-faint transition-colors hover:text-ink">
        <History className="size-3.5" strokeWidth={1.75} />
        Activity
        <span className="font-mono font-normal normal-case tracking-normal">{visible.length}</span>
        <ChevronDown className={cx("size-3.5 transition-transform", open && "rotate-180")} strokeWidth={1.75} />
      </button>
      {open ? (
        <ol className="mt-3 flex flex-col gap-1.5 text-[12.5px] text-ink-muted">
          {visible.map((e) => {
            const who = e.actorKind === "agent" ? agentName : e.actorKind === "system" ? "kardboard" : e.actorId ? (members.get(e.actorId)?.name ?? "Someone") : "Someone";
            const label = ACTIVITY_LABEL[e.type]?.(e.payload) ?? e.type;
            return (
              <li key={e.id} className="flex gap-2">
                <span className="w-16 shrink-0 font-mono text-[11px] text-ink-faint" title={absoluteTime(e.createdAt)}>
                  {relativeTime(e.createdAt)}
                </span>
                <span>
                  <span className={cx(e.actorKind === "agent" ? "text-accent" : "text-ink")}>{who}</span> {label}
                </span>
              </li>
            );
          })}
        </ol>
      ) : null}
    </div>
  );
}
