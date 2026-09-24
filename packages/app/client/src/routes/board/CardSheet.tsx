import { forwardRef, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ArrowUpRight, Check, ChevronDown, GitBranch, GitPullRequest, History, Link2, Pencil, Reply, Trash2, Upload, X } from "lucide-react";
import { COLUMNS, COLUMN_LABELS, PRIORITIES, type ActivityEntry, type AgentProfile, type BoardView, type Card, type Column, type Comment, type Person, type Priority, type Provider, type User } from "@kardboard/shared";
import { useCard, useCreateComment, useDeleteComment, useMarkCardRead, useMe, useMoveCard, useUpdateCard, useUpdateComment } from "../../lib/api";
import { useNavigate } from "react-router";
import { Avatar, Button, Chip, cx, ErrorState, IconButton, Input, Skeleton, Textarea } from "../../components/ui";
import { Dialog } from "../../components/Dialog";
import { Menu } from "../../components/Menu";
import { Markdown } from "../../components/Markdown";
import { absoluteTime, relativeTime, shortId } from "../../lib/format";
import { useFileDrop } from "../../lib/fileInput";
import { toast } from "../../lib/toast";
import { Composer, type ComposerHandle } from "./Composer";
import { COLUMN_TONES } from "./columns";
import { WorkingDot } from "./CardTile";
import { SessionBanner } from "./SessionBanner";
import { ApiError } from "../../lib/errors";
import { AttachmentView } from "./AttachmentView";
import { PreviewLink } from "./PreviewLink";
import { EditConflict, resolveRefusedSave, type EditableField, type EditBase } from "./cardEdits";
import { isInnermostModal, useModalFocus } from "../../components/focus";
import { ReviewBlock } from "./ReviewBlock";

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
      if (e.key === "Escape" && isInnermostModal(sheet) && !(e.target instanceof HTMLTextAreaElement) && !(e.target instanceof HTMLInputElement)) onClose();
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
  const markRead = useMarkCardRead();
  // Names come from everyone the Board has seen, so a removed Member still signs their Comments.
  const people = useMemo(() => new Map<string, Person>(view.people.map((p) => [p.id, p])), [view.people]);
  const handles = useMemo(() => {
    const m = new Map(view.people.map((u) => [u.handle, u.name]));
    m.set(view.agent.name.toLowerCase(), view.agent.name);
    return m;
  }, [view.people, view.agent.name]);
  const card = detail.data?.card ?? view.cards.find((c) => c.id === cardId);
  const isAdmin = me.data?.user.role === "admin";
  const composer = useRef<ComposerHandle>(null);
  const drop = useFileDrop((files) => composer.current?.addFiles(files), Boolean(card));
  const markCardRead = markRead.mutate;
  useEffect(() => {
    markCardRead(cardId);
  }, [cardId, markCardRead]);
  // Request changes in the Review block hands over to the comment composer, with a prompt for what to write.
  const [composerHint, setComposerHint] = useState<string | null>(null);
  const requestChanges = () => {
    setComposerHint("What should change?");
    composer.current?.focus();
  };

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
    // Files dropped anywhere on the sheet go to the comment being written.
    <div className="relative flex min-h-0 flex-1 flex-col" {...drop.handlers}>
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
          items={COLUMNS.map((c) => ({
            label: COLUMN_LABELS[c],
            active: c === card.column,
            onSelect: () => c !== card.column && move.mutate({ id: card.id, column: c, position: Number.MAX_SAFE_INTEGER / 2, revision: card.revision }, { onError: (err) => toast(`The card was not moved to ${COLUMN_LABELS[c]}. ${err.message}`) }),
          }))}
        />
        <span className="font-mono text-[11.5px] text-ink-faint">{shortId(card.id)}</span>
        <span className="ml-auto" />
        <CopyLink slug={slug} cardId={card.id} />
        <Menu
          align="right"
          trigger={
            <button className="inline-flex h-7 items-center gap-1 rounded-control px-2 text-[12.5px] text-ink-muted hover:bg-raised hover:text-ink">
              {PRIORITY_LABELS[card.priority]}
              <ChevronDown className="size-3.5" strokeWidth={1.75} />
            </button>
          }
          items={PRIORITIES.map((p) => ({
            label: PRIORITY_LABELS[p],
            active: p === card.priority,
            onSelect: () => p !== card.priority && update.mutate({ id: card.id, priority: p, revision: card.revision }, { onError: (err) => toast(`The priority was not changed. ${err.message}`) }),
          }))}
        />
        <IconButton label="Close" onClick={onClose}>
          <X className="size-4" strokeWidth={1.75} />
        </IconButton>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="px-6 pt-5">
          <TitleEditor card={card} labelId={titleId} onSave={(title, base) => saveField("title", title, base)} />
          <p className="mt-1.5 text-[12px] text-ink-faint">
            Opened {relativeTime(card.createdAt)} by {card.creatorKind === "agent" ? view.agent.name : (card.creatorId && people.get(card.creatorId)?.name) || "someone"}
            {card.parentCardId ? <> as part of a larger request</> : null}
          </p>
        </div>
        <BlockedQuestion card={card} comments={detail.data?.comments} agent={view.agent} handles={handles} onReply={() => composer.current?.focus()} />

        <SessionBanner slug={slug} card={card} agentName={view.agent.name} isAdmin={isAdmin} />

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
            <PreviewLink card={card} />
          </div>
        ) : null}

        {card.column === "review" ? (
          <ReviewBlock
            slug={slug}
            card={card}
            agentName={view.agent.name}
            approvals={detail.data?.approvals ?? []}
            members={people}
            isAdmin={isAdmin}
            onRequestChanges={requestChanges}
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
            <CommentList comments={detail.data.comments} people={people} mentionable={view.members} agent={view.agent} handles={handles} meId={me.data?.user.id ?? ""} isAdmin={Boolean(isAdmin)} cardId={card.id} />
          )}
        </div>
        <div className="px-6 pb-4">
          <NewComment ref={composer} cardId={card.id} members={view.members} agent={view.agent} placeholder={composerHint ?? undefined} onPosted={() => setComposerHint(null)} />
        </div>
        <Activity entries={detail.data?.activity ?? []} people={people} agentName={view.agent.name} />
      </div>
      <DropHint show={drop.over} />
    </div>
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

// Authors edit their own Comments. Authors and the Admin delete them; only the Admin can delete the
// Agent's. The controls sit on the Comment's line and show on hover, or always on a touch screen.
function CommentList({
  comments,
  people,
  mentionable,
  agent,
  handles,
  meId,
  isAdmin,
  cardId,
}: {
  comments: Comment[];
  people: Map<string, Person>;
  mentionable: User[];
  agent: AgentProfile;
  handles: Map<string, string>;
  meId: string;
  isAdmin: boolean;
  cardId: string;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<Comment | null>(null);
  const updateComment = useUpdateComment(cardId);
  const deleteComment = useDeleteComment(cardId);
  const closeDelete = () => {
    setDeleting(null);
    deleteComment.reset();
  };
  // The Delete button the dialog would hand focus back to is gone with its comment, so focus lands
  // on the list instead of falling to the page.
  const list = useRef<HTMLOListElement>(null);
  const deleted = () => {
    closeDelete();
    requestAnimationFrame(() => list.current?.focus({ preventScroll: true }));
  };
  const control = "text-ink-faint opacity-0 transition-opacity hover:text-ink focus-visible:opacity-100 [li:hover_&]:opacity-100 [@media(hover:none)]:opacity-100";
  return (
    <>
      {comments.length === 0 ? <p className="text-[13px] text-ink-faint">No comments yet.</p> : null}
      <ol ref={list} tabIndex={-1} aria-label="Comments" className="flex flex-col gap-5 outline-none">
        {comments.map((c) => {
          // A kardboard notice, such as a Session that stopped short, is signed by kardboard itself.
          const author = c.authorKind === "agent" ? agent : c.authorKind === "system" ? { name: "kardboard", avatarUrl: null } : c.authorId ? people.get(c.authorId) : undefined;
          const mine = c.authorKind === "user" && c.authorId === meId;
          const canDelete = mine || isAdmin;
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
                  {editingId !== c.id && (mine || canDelete) ? (
                    <span className="ml-auto flex items-center gap-3">
                      {mine ? (
                        <button type="button" aria-label="Edit comment" className={control} onClick={() => setEditingId(c.id)}>
                          Edit
                        </button>
                      ) : null}
                      {canDelete ? (
                        <button type="button" aria-label="Delete comment" className={cx(control, "hover:text-danger")} onClick={() => setDeleting(c)}>
                          Delete
                        </button>
                      ) : null}
                    </span>
                  ) : null}
                </div>
                {editingId === c.id ? (
                  <div className="mt-1.5">
                    <Composer
                      members={mentionable}
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
      <Dialog open={deleting !== null} onClose={closeDelete} title="Delete this comment?" width={420}>
        <p className="text-[13px] leading-relaxed text-ink-muted">
          {deleting?.authorKind === "agent" ? `${agent.name}'s comment` : "The comment"}
          {deleting?.attachments.length ? " and its attachments are" : " is"} removed for everyone. This cannot be undone.
        </p>
        {deleteComment.isError ? (
          <p role="alert" className="mt-3 text-[13px] text-danger">
            The comment was not deleted. {deleteComment.error.message}
          </p>
        ) : null}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={closeDelete}>
            Cancel
          </Button>
          <Button variant="danger" loading={deleteComment.isPending} icon={<Trash2 className="size-4" strokeWidth={1.75} />} onClick={() => deleting && deleteComment.mutate(deleting.id, { onSuccess: deleted })}>
            Delete
          </Button>
        </div>
      </Dialog>
    </>
  );
}

const NewComment = forwardRef<ComposerHandle, { cardId: string; members: User[]; agent: AgentProfile; placeholder?: string; onPosted?: () => void }>(function NewComment(
  { cardId, members, agent, placeholder, onPosted },
  ref,
) {
  const create = useCreateComment(cardId);
  return (
    <div className="mt-5 border-t border-line pt-4">
      <Composer
        ref={ref}
        members={members}
        agent={agent}
        placeholder={placeholder}
        onSubmit={(body, files, onProgress) => create.mutateAsync({ body, files, onProgress }).then(() => onPosted?.())}
      />
    </div>
  );
});

// A Card's address, for pasting into a chat or an email. Opening it lands on the Card over its Board.
function CopyLink({ slug, cardId }: { slug: string; cardId: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/b/${slug}/c/${cardId}`);
      setCopied(true);
    } catch {
      toast("The link was not copied. Copy it from the address bar instead.");
    }
  };
  return (
    <IconButton label={copied ? "Link copied" : "Copy link"} className="size-7" onClick={() => void copy()}>
      <AnimatePresence mode="wait" initial={false}>
        <motion.span key={copied ? "done" : "link"} initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }} transition={{ duration: 0.12 }} className="inline-flex">
          {copied ? <Check className="size-4 text-ok" strokeWidth={2} /> : <Link2 className="size-4" strokeWidth={1.75} />}
        </motion.span>
      </AnimatePresence>
      <span className="sr-only" aria-live="polite">
        {copied ? "Link copied" : ""}
      </span>
    </IconButton>
  );
}

function DropHint({ show }: { show: boolean }) {
  return (
    <AnimatePresence>
      {show ? (
        <motion.div
          key="drop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.12 }}
          className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-card border border-dashed border-accent/60 bg-surface/90 text-[13px] font-medium text-accent"
        >
          <Upload className="mr-2 size-4" strokeWidth={1.75} />
          Drop to attach to your comment
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

// When the Agent's question is the last word on a Blocked Card it comes first, where nobody can miss
// it, with a way straight to the reply box. The same Comment stays in the thread below.
function BlockedQuestion({ card, comments, agent, handles, onReply }: { card: Card; comments: Comment[] | undefined; agent: AgentProfile; handles: Map<string, string>; onReply: () => void }) {
  const reduce = useReducedMotion();
  const question = card.column === "blocked" && card.awaitingReply ? [...(comments ?? [])].reverse().find((c) => c.authorKind === "agent") : undefined;
  return (
    <AnimatePresence initial={false}>
      {question ? (
        <motion.section
          key="question"
          aria-label={`${agent.name} is asking`}
          initial={reduce ? false : { opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          className="mx-6 mt-4 rounded-card border border-warn/30 bg-[rgba(217,178,108,0.07)] px-4 py-3.5"
        >
          <div className="flex items-center gap-2">
            <Avatar name={agent.name} url={agent.avatarUrl} size={22} tone="agent" />
            <p className="text-[13px] font-medium text-warn">{agent.name} is asking:</p>
            <span className="ml-auto text-[11.5px] text-ink-faint" title={absoluteTime(question.createdAt)}>
              {relativeTime(question.createdAt)}
            </span>
          </div>
          <ClampedMarkdown body={question.body} handles={handles} />
          <Button size="sm" variant="primary" className="mt-3" icon={<Reply className="size-3.5" strokeWidth={2} />} onClick={onReply}>
            Reply
          </Button>
        </motion.section>
      ) : null}
    </AnimatePresence>
  );
}

// A long question is cut to a few lines, fading out, with a control to read the rest in place.
function ClampedMarkdown({ body, handles }: { body: string; handles: Map<string, string> }) {
  const box = useRef<HTMLDivElement>(null);
  const [overflows, setOverflows] = useState(false);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => setOverflows(el.scrollHeight > el.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [body, open]);
  return (
    <>
      <div ref={box} className={cx("mt-2 overflow-hidden", !open && "max-h-40", !open && overflows && "[mask-image:linear-gradient(to_bottom,black_60%,transparent)]")}>
        <Markdown body={body} handles={handles} />
      </div>
      {overflows || open ? (
        <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)} className="mt-1 text-[12px] text-ink-muted transition-colors hover:text-ink">
          {open ? "Show less" : "Read the whole question"}
        </button>
      ) : null}
    </>
  );
}

const PROVIDER_LABELS: Record<Provider, string> = { claude: "Claude Code", codex: "Codex" };

function pieces(p: Record<string, unknown>): string {
  const n = Array.isArray(p.children) ? p.children.length : 0;
  return n === 1 ? "the one piece of this request is finished" : `all ${n} pieces of this request are finished`;
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
  "card.retry_requested": () => "asked to try again",
  "card.merge_refused": (p) => `could not merge the pull request${p.error ? `: ${p.error as string}` : ""}`,
  "card.merge_retried": () => "tried the merge again",
  "pull_request.closed": (p) => `saw pull request #${p.prNumber as number} closed on GitHub without a merge`,
  "pull_request.head_changed": (p) => `saw new commits on pull request #${p.prNumber as number}`,
  "session.reported": (p) => `reported${p.summary ? `: ${p.summary as string}` : ""}`,
  "session.provider_fallback": (p) => `moved the work from ${PROVIDER_LABELS[p.from as Provider] ?? p.from} to ${PROVIDER_LABELS[p.to as Provider] ?? p.to}, which had usage left`,
  "preview.requested": () => "started building a preview",
  "card.merged": (p) => `merged pull request${p.prNumber ? ` #${p.prNumber as number}` : ""}`,
  "card.children_done": (p) => `noted that ${pieces(p)}`,
  "comment.deleted": () => "deleted a comment",
};

function Activity({ entries, people, agentName }: { entries: ActivityEntry[]; people: Map<string, Person>; agentName: string }) {
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
            const who = e.actorKind === "agent" ? agentName : e.actorKind === "system" ? "kardboard" : e.actorId ? (people.get(e.actorId)?.name ?? "Someone") : "Someone";
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
