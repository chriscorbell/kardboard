import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { closestCorners, DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDown, CircleHelp, Plus, RefreshCw } from "lucide-react";
import { COLUMNS, COLUMN_LABELS, type AgentProfile, type Card, type Column, type Person } from "@kardboard/shared";
import { ApiError, useBoard, useMe, useMoveCard, useUpdateMe } from "../lib/api";
import { useBoardEvents } from "../lib/realtime";
import { documentTitle, useDocumentTitle } from "../lib/documentTitle";
import { toast } from "../lib/toast";
import { Button, cx, ErrorState, IconButton, Skeleton } from "../components/ui";
import { CardTile } from "./board/CardTile";
import { AgentPill } from "./board/AgentPill";
import { NewCardDialog } from "./board/NewCardDialog";
import { CardSheet } from "./board/CardSheet";
import { columnHint } from "./board/columns";
import { dropPlacement } from "./board/dropPlacement";
import { filterActive, foldDone, matchesFilter, readFilter, waitsOn, writeFilter, type BoardFilter, type Viewer } from "./board/boardFilter";
import { BoardSearch, FilterChips } from "./board/BoardFilters";
import { HowItWorks } from "./board/HowItWorks";

// Enter opens a card, so only Space picks one up; the instructions read to screen readers say so.
const KEYBOARD_CODES = { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter", "Tab"] };
const SCREEN_READER_INSTRUCTIONS = {
  draggable: "To open a card, press Enter. To move it, press Space to pick it up, use the arrow keys to move it within or between columns, then press Space again to drop it, or Escape to cancel.",
};

function SortableCard({ card, creator, agent, questionIsMine, onOpen }: { card: Card; creator: Person | undefined; agent: AgentProfile; questionIsMine: boolean; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id, data: { column: card.column } });
  return (
    <CardTile
      ref={setNodeRef}
      card={card}
      creator={creator}
      agent={agent}
      questionIsMine={questionIsMine}
      dragging={isDragging}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className="cursor-grab touch-manipulation active:cursor-grabbing"
      onClick={onOpen}
      {...attributes}
      {...listeners}
      onKeyDown={(e) => {
        if (e.key === "Enter" && !isDragging) return onOpen();
        listeners?.onKeyDown?.(e);
      }}
      role="button"
      tabIndex={0}
    />
  );
}

// Done folds away all but its most recent Cards; this is the control that unfolds it again.
type Fold = { hidden: number; expanded: boolean; onToggle: () => void };

function ColumnLane({
  column,
  cards,
  people,
  agent,
  viewer,
  onOpen,
  onNew,
  canAdd,
  filtering,
  fold,
}: {
  column: Column;
  cards: Card[];
  people: Map<string, Person>;
  agent: AgentProfile;
  viewer: Viewer;
  onOpen: (id: string) => void;
  onNew: () => void;
  canAdd: boolean;
  filtering: boolean;
  fold?: Fold;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${column}`, data: { column } });
  const reduce = useReducedMotion();
  return (
    <section className="flex min-w-[84vw] flex-1 snap-start snap-always flex-col sm:min-w-[228px] lg:max-w-[320px]" aria-label={COLUMN_LABELS[column]}>
      <header className="flex h-9 items-center gap-2 px-1">
        <h2 className="text-[13px] font-semibold text-ink">{COLUMN_LABELS[column]}</h2>
        <span className="font-mono text-[11.5px] text-ink-faint">{cards.length}</span>
        {canAdd ? (
          <IconButton label="New card" className="ml-auto size-7" onClick={onNew}>
            <Plus className="size-4" strokeWidth={1.75} />
          </IconButton>
        ) : null}
      </header>
      <div
        ref={setNodeRef}
        className={cx("flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-card border border-transparent p-1 transition-colors duration-150", isOver && "border-line-strong bg-raised/40")}
      >
        <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
          <AnimatePresence initial={false}>
            {cards.map((card) => (
              <motion.div key={card.id} layout={!reduce} initial={reduce ? false : { opacity: 0, scale: 0.97 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.97 }} transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}>
                <SortableCard card={card} creator={card.creatorId ? people.get(card.creatorId) : undefined} agent={agent} questionIsMine={waitsOn(card, viewer)} onOpen={() => onOpen(card.id)} />
              </motion.div>
            ))}
          </AnimatePresence>
        </SortableContext>
        {cards.length === 0 ? <p className="px-2 py-6 text-center text-[12px] leading-relaxed text-ink-faint">{filtering ? "No matching cards." : columnHint(column, agent.name)}</p> : null}
        {fold && (fold.hidden > 0 || fold.expanded) ? (
          <button
            type="button"
            onClick={fold.onToggle}
            aria-expanded={fold.expanded}
            className="mx-auto mt-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-control px-2.5 text-[12px] text-ink-muted transition-colors hover:bg-raised hover:text-ink"
          >
            {fold.expanded ? "Show fewer" : `Show ${fold.hidden} older`}
            <ChevronDown className={cx("size-3.5 transition-transform duration-200", fold.expanded && "rotate-180")} strokeWidth={1.75} />
          </button>
        ) : null}
      </div>
    </section>
  );
}

export function BoardPage() {
  const { slug = "", cardId } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const me = useMe();
  const board = useBoard(slug);
  useBoardEvents(slug);
  const move = useMoveCard(slug);
  const updateMe = useUpdateMe();
  const [creating, setCreating] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [doneExpanded, setDoneExpanded] = useState(false);
  // Null until the User opens or closes the explainer: until then it shows only on a first visit.
  const [helpOpen, setHelpOpen] = useState<boolean | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const filter = useMemo(() => readFilter(params), [params]);
  const setFilter = useCallback((next: BoardFilter) => setParams((p) => writeFilter(next, p), { replace: true }), [setParams]);
  const filtering = filterActive(filter);
  const viewer = useMemo(() => ({ id: me.data?.user.id ?? "", isAdmin: me.data?.user.role === "admin" }), [me.data?.user.id, me.data?.user.role]);
  const showHelp = helpOpen ?? (me.data !== undefined && me.data.onboardedAt === null);
  const closeHelp = () => {
    setHelpOpen(false);
    if (me.data && me.data.onboardedAt === null) updateMe.mutate({ onboarded: true });
  };
  // Opening and closing a Card keeps the board's filters, which live in the query.
  const openCard = useCallback((id: string) => navigate({ pathname: `/b/${slug}/c/${id}`, search: location.search }), [navigate, slug, location.search]);
  const closeCard = useCallback(() => navigate({ pathname: `/b/${slug}`, search: location.search }), [navigate, slug, location.search]);

  const openCardTitle = cardId ? board.data?.cards.find((c) => c.id === cardId)?.title : null;
  useDocumentTitle(board.data ? documentTitle([openCardTitle, board.data.board.name]) : null);

  // "/" jumps to search from anywhere on the board that is not already taking typed text.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "/" || e.metaKey || e.ctrlKey || e.altKey || cardId || creating) return;
      const t = e.target;
      if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement || (t instanceof HTMLElement && t.isContentEditable)) return;
      e.preventDefault();
      search.current?.focus();
      search.current?.select();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [cardId, creating]);
  // A touch has to rest on a card before it drags, so a swipe still scrolls the board.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: KEYBOARD_CODES }),
  );

  const people = useMemo(() => new Map((board.data?.people ?? []).map((p) => [p.id, p])), [board.data?.people]);
  // What each column shows: the Cards matching the filter, in board order, and Done folded to its
  // most recent unless the filter is looking for something or the column has been unfolded.
  const { byColumn, doneHidden, waiting } = useMemo(() => {
    const map: Record<Column, Card[]> = { inbox: [], blocked: [], ready: [], in_progress: [], review: [], done: [] };
    let waiting = 0;
    for (const c of board.data?.cards ?? []) {
      if (waitsOn(c, viewer)) waiting++;
      if (matchesFilter(c, filter, viewer)) map[c.column].push(c);
    }
    for (const col of COLUMNS) map[col].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
    let doneHidden = 0;
    if (!filtering && !doneExpanded) {
      const folded = foldDone(map.done);
      map.done = folded.shown;
      doneHidden = folded.hidden;
    }
    return { byColumn: map, doneHidden, waiting };
  }, [board.data?.cards, filter, filtering, viewer, doneExpanded]);
  const activeCard = activeId ? board.data?.cards.find((c) => c.id === activeId) : undefined;
  const activeSessions = (board.data?.sessions ?? []).filter((s) => s.status === "running" || s.status === "starting");

  const onDragStart = useCallback((e: DragStartEvent) => setActiveId(String(e.active.id)), []);
  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      setActiveId(null);
      const { active, over } = e;
      if (!over || !board.data) return;
      const card = board.data.cards.find((c) => c.id === active.id);
      if (!card) return;
      const overId = String(over.id);
      const onColumn = overId.startsWith("col:");
      const targetColumn = onColumn ? (overId.slice(4) as Column) : (board.data.cards.find((c) => c.id === overId)?.column ?? card.column);
      // Placed among every Card in the column, not only those the filter or the folded Done shows:
      // a position worked out from the visible ones alone can land on a hidden Card's.
      const whole = board.data.cards.filter((c) => c.column === targetColumn).sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
      const placed = dropPlacement(whole, card.id, onColumn ? null : overId);
      if (!placed) return;
      // The card springs back on a refusal, which says nothing about why without this.
      move.mutate({ id: card.id, column: targetColumn, position: placed.position, revision: card.revision }, { onError: (err) => toast(`“${card.title}” was not moved. ${err.message}`) });
    },
    [board.data, move],
  );

  if (board.isPending) {
    return (
      <div className="flex h-full gap-3 overflow-hidden p-4">
        {COLUMNS.map((c) => (
          <div key={c} className="flex min-w-[228px] flex-1 flex-col gap-2">
            <Skeleton className="mb-2 h-5 w-24" />
            <Skeleton className="h-16" />
            <Skeleton className="h-20" />
          </div>
        ))}
      </div>
    );
  }
  // Loaded data outlives a failed refetch: the board stays on screen, with a quiet note in the toolbar.
  if (!board.data) {
    const missing = board.error instanceof ApiError && (board.error.status === 403 || board.error.status === 404);
    if (missing) {
      return (
        <div className="flex h-full items-center justify-center text-sm text-ink-muted">
          This board does not exist or you do not have access to it.
        </div>
      );
    }
    return (
      <div className="mx-auto max-w-md p-8">
        <ErrorState title="Could not load this board." error={board.error} onRetry={() => void board.refetch()} retrying={board.isFetching} />
      </div>
    );
  }
  const isAdmin = me.data?.user.role === "admin";
  const agent = board.data.agent;

  const helpButton = (className: string) => (
    <IconButton label="How this board works" aria-expanded={showHelp} className={cx("size-7 shrink-0", className)} onClick={() => (showHelp ? closeHelp() : setHelpOpen(true))}>
      <CircleHelp className="size-4" strokeWidth={1.75} />
    </IconButton>
  );

  // One row on a wide screen. On a phone the search shares the first row with New card, the filters
  // take the second, and the Agent's status joins them or wraps below when there is no room.
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 flex-col gap-2 border-b border-line px-4 py-2 sm:flex-row sm:items-center sm:gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <Button size="sm" variant="primary" className="shrink-0" icon={<Plus className="size-3.5" strokeWidth={2} />} onClick={() => setCreating(true)}>
            New card
          </Button>
          <BoardSearch ref={search} value={filter.q} onChange={(q) => setFilter({ ...filter, q })} className="min-w-0 flex-1 sm:w-56 sm:flex-none" />
          {helpButton("sm:hidden")}
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          <FilterChips filter={filter} onChange={setFilter} waiting={waiting} className="max-w-full" />
          <div className="ml-auto flex shrink-0 items-center gap-2 text-[12.5px] text-ink-muted">
            <AnimatePresence initial={false}>
              {board.isError ? (
                <motion.button
                  key="stale"
                  type="button"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.2 }}
                  onClick={() => void board.refetch()}
                  title={board.error.message}
                  aria-label="Could not refresh the board. Try again"
                  className="inline-flex h-7 items-center gap-1.5 rounded-control px-2 text-[12.5px] text-ink-faint transition-colors hover:bg-raised hover:text-ink"
                >
                  <RefreshCw className={cx("size-3.5 text-warn", board.isFetching && "animate-spin")} strokeWidth={1.75} />
                  <span className="hidden sm:inline">Could not refresh</span>
                </motion.button>
              ) : null}
            </AnimatePresence>
            <AgentPill slug={slug} board={board.data.board} agent={agent} working={activeSessions.length} isAdmin={Boolean(isAdmin)} />
          </div>
          {helpButton("max-sm:hidden")}
        </div>
      </div>
      <HowItWorks open={showHelp} agent={agent} onClose={closeHelp} />
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        accessibility={{ screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        {/* On a phone each swipe lands one column against the gutter. Snapping pauses while a card is
            dragged, so the auto-scroll toward the next column is not pulled back. */}
        <div className={cx("flex min-h-0 flex-1 scroll-px-4 gap-3 overflow-x-auto overscroll-x-contain px-4 pb-4 pt-3", activeId ? "snap-none" : "snap-x snap-mandatory sm:snap-none")}>
          {COLUMNS.map((column) => (
            <ColumnLane
              key={column}
              column={column}
              cards={byColumn[column]}
              people={people}
              agent={agent}
              viewer={viewer}
              onOpen={openCard}
              onNew={() => setCreating(true)}
              canAdd={column === "inbox"}
              filtering={filtering}
              fold={column === "done" ? { hidden: doneHidden, expanded: doneExpanded, onToggle: () => setDoneExpanded((x) => !x) } : undefined}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }}>
          {activeCard ? <CardTile card={activeCard} creator={activeCard.creatorId ? people.get(activeCard.creatorId) : undefined} agent={agent} questionIsMine={waitsOn(activeCard, viewer)} overlay className="w-[284px]" /> : null}
        </DragOverlay>
      </DndContext>
      <NewCardDialog slug={slug} open={creating} onClose={() => setCreating(false)} isAdmin={Boolean(isAdmin)} onCreated={openCard} />
      <CardSheet slug={slug} cardId={cardId ?? null} view={board.data} onClose={closeCard} />
    </div>
  );
}
