import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { closestCenter, DndContext, DragOverlay, getFirstCollision, KeyboardSensor, MeasuringStrategy, MouseSensor, pointerWithin, rectIntersection, TouchSensor, useDroppable, useSensor, useSensors, type CollisionDetection, type DragEndEvent, type KeyboardCoordinateGetter, type DragOverEvent, type DragStartEvent, type DropAnimation, type UniqueIdentifier } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronDown, ChevronsLeft, ChevronsRight, CircleHelp, Plus, RefreshCw } from "lucide-react";
import { COLUMNS, COLUMN_LABELS, type AgentProfile, type Card, type Column, type Person } from "@kardboard/shared";
import { ApiError, useBoard, useMe, useMoveCard, useUpdateMe } from "../lib/api";
import { useBoardEvents } from "../lib/realtime";
import { documentTitle, useDocumentTitle } from "../lib/documentTitle";
import { toast } from "../lib/toast";
import { Button, cx, ErrorState, IconButton, Skeleton } from "../components/ui";
import { CardTile } from "./board/CardTile";
import { NewCardDialog } from "./board/NewCardDialog";
import { CardSheet } from "./board/CardSheet";
import { columnHint } from "./board/columns";
import { columnDropId, dropSpot, laneOf, moveAcross, placeBefore, settleWithin, type Lanes } from "./board/dragLanes";
import { readDoneOpen, writeDoneOpen } from "./board/doneColumn";
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

// Columns change size as the dragged card leaves one and opens a gap in another, so they are measured
// throughout a drag rather than once at its start.
const MEASURING = { droppable: { strategy: MeasuringStrategy.Always } };

// Quick to arrive and still once it has: an ease with a long tail creeps the last few pixels after the
// card seems to have landed, which reads as a second movement.
const DROP_EASE = "cubic-bezier(0.25, 1, 0.5, 1)";
const DROP_MS = 200;
// The lifted card is the card itself, the same size and square, with a shadow. It glides onto the gap
// it fills and lays the shadow down on the way, so when it gives way to the card underneath nothing
// moves or changes. That card stays hidden until then and appears at once, covered exactly as it was.
// Dropped on a collapsed column, which has no gap to fill, it shrinks and fades into the strip instead.
function dropAnimation(tuck: { current: boolean }): DropAnimation {
  return {
    duration: DROP_MS,
    easing: DROP_EASE,
    keyframes({ transform, active, dragOverlay }) {
      if (!tuck.current) return [{ transform: CSS.Transform.toString(transform.initial) }, { transform: CSS.Transform.toString(transform.final) }];
      const dx = active.rect.left + active.rect.width / 2 - (dragOverlay.rect.left + dragOverlay.rect.width / 2);
      const dy = active.rect.top + active.rect.height / 2 - (dragOverlay.rect.top + dragOverlay.rect.height / 2);
      return [
        { transform: CSS.Transform.toString(transform.initial), opacity: 1 },
        { transform: `translate3d(${transform.initial.x + dx}px, ${transform.initial.y + dy}px, 0) scale(0.4)`, opacity: 0 },
      ];
    },
    sideEffects({ active, dragOverlay }) {
      active.node.style.opacity = "0";
      const lifted = dragOverlay.node.firstElementChild;
      if (!tuck.current && lifted instanceof HTMLElement) {
        const from = getComputedStyle(lifted);
        const to = getComputedStyle(active.node);
        lifted.animate(
          [
            { boxShadow: from.boxShadow, borderColor: from.borderColor },
            { boxShadow: to.boxShadow, borderColor: to.borderColor },
          ],
          { duration: DROP_MS, easing: DROP_EASE, fill: "forwards" },
        );
      }
      return () => {
        active.node.style.opacity = "";
      };
    },
  };
}

// Local storage, where the browser allows it: a private window can refuse even to hand it over.
function browserStorage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
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
  dragging,
  targeted,
  collapse,
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
  /** A card is being dragged, or its drop is settling: the drag library moves cards, not their own animations. */
  dragging: boolean;
  /** The column the dragged card would land in. */
  targeted: boolean;
  /** A column that can fold down to a narrow strip: whether it is open, and the dragged card, which it holds hidden while the card is over it shut. */
  collapse?: { open: boolean; onToggle: () => void; activeId: string | null; toggled: boolean };
  fold?: Fold;
}) {
  const { setNodeRef } = useDroppable({ id: columnDropId(column), data: { column } });
  const reduce = useReducedMotion();
  const shut = Boolean(collapse && !collapse.open);
  const label = COLUMN_LABELS[column];
  // Every card the column holds, the folded ones too: the strip stands for the whole column.
  const count = cards.length + (fold?.hidden ?? 0);
  // Opening or closing eases the column's width, and its neighbours give or take the space with it.
  // What the column shows keeps its own width while that happens, so it is uncovered rather than squeezed.
  const appear = collapse?.toggled && !reduce ? { initial: { opacity: 0 }, animate: { opacity: 1 }, transition: { duration: 0.2, delay: 0.08 } } : { initial: false as const };
  const held = shut && collapse?.activeId ? cards.find((c) => c.id === collapse.activeId) : undefined;
  return (
    <section
      className={cx(
        "flex snap-start snap-always flex-col",
        collapse && "relative overflow-hidden transition-[flex-grow,flex-basis,min-width] duration-300 ease-out-expo",
        // Open columns share the whole width of the board, however wide, down to a floor below which it
        // scrolls. A shut one is its strip's width exactly, and gives the rest to its neighbours.
        shut ? "min-w-11 shrink-0 grow-0 basis-11" : "min-w-[84vw] grow basis-0 sm:min-w-[228px]",
      )}
      aria-label={label}
    >
      {shut ? (
        <motion.div key="strip" {...appear} className="flex min-h-0 flex-1 flex-col">
          <button
            ref={setNodeRef}
            type="button"
            onClick={collapse?.onToggle}
            aria-expanded={false}
            aria-label={`Show ${label}, ${count} ${count === 1 ? "card" : "cards"}`}
            title={`Show ${label}`}
            className={cx(
              "group flex min-h-0 flex-1 flex-col items-center gap-2.5 rounded-card border border-transparent pt-2.5 transition-colors duration-150 hover:bg-raised/60",
              targeted && "border-line-strong bg-raised/40",
            )}
          >
            <ChevronsLeft className="size-4 text-ink-faint transition-colors group-hover:text-ink" strokeWidth={1.75} aria-hidden="true" />
            <span className="text-[13px] font-semibold text-ink [writing-mode:vertical-rl]">{label}</span>
            <span className="font-mono text-[11.5px] text-ink-faint">{count}</span>
          </button>
          {/* The dragged card, over the strip, still needs a place in it for the drop to land on. */}
          {held ? (
            <div inert className="pointer-events-none absolute inset-x-1 top-12 opacity-0">
              <SortableContext items={[held.id]} strategy={verticalListSortingStrategy}>
                <SortableCard card={held} creator={held.creatorId ? people.get(held.creatorId) : undefined} agent={agent} questionIsMine={false} onOpen={() => undefined} />
              </SortableContext>
            </div>
          ) : null}
        </motion.div>
      ) : (
        <motion.div key="lane" {...appear} className={cx("flex min-h-0 flex-1 flex-col", collapse && "min-w-[220px]")}>
          <header className="flex h-9 items-center gap-2 px-1">
            <h2 className="text-[13px] font-semibold text-ink">{label}</h2>
            <span className="font-mono text-[11.5px] text-ink-faint">{cards.length}</span>
            {canAdd ? (
              <IconButton label="New card" className="ml-auto size-7" onClick={onNew}>
                <Plus className="size-4" strokeWidth={1.75} />
              </IconButton>
            ) : null}
            {collapse ? (
              <IconButton type="button" label={`Collapse ${label}`} aria-expanded className="ml-auto size-7" onClick={collapse.onToggle}>
                <ChevronsRight className="size-4" strokeWidth={1.75} />
              </IconButton>
            ) : null}
          </header>
          <div
            ref={setNodeRef}
            className={cx("flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto rounded-card border border-transparent p-1 transition-colors duration-150", targeted && "border-line-strong bg-raised/40")}
          >
            <SortableContext items={cards.map((c) => c.id)} strategy={verticalListSortingStrategy}>
              <AnimatePresence initial={false}>
                {cards.map((card) => (
                  // A card arriving or leaving animates, and others close up after it, unless it is the dragged
                  // card changing columns: that move belongs to the drag library, and two animations of it jump.
                  <motion.div
                    key={card.id}
                    layout={!reduce && !dragging}
                    initial={reduce || dragging ? false : { opacity: 0, scale: 0.97 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={dragging ? undefined : { opacity: 0, scale: 0.97 }}
                    transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
                  >
                    <SortableCard card={card} creator={card.creatorId ? people.get(card.creatorId) : undefined} agent={agent} questionIsMine={waitsOn(card, viewer)} onOpen={() => onOpen(card.id)} />
                  </motion.div>
                ))}
              </AnimatePresence>
            </SortableContext>
            {cards.length === 0 ? <p className="px-2 py-6 text-center text-[12px] leading-relaxed text-ink-faint">{filtering ? "No matching cards." : columnHint(column)}</p> : null}
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
        </motion.div>
      )}
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
  // The order each column shows from the moment a card is picked up until the board data shows where
  // it was dropped. The dragged card moves between lanes as it crosses columns, and holding the lanes
  // past the drop keeps the card from flicking back while the move is on its way to the server.
  const reduce = useReducedMotion();
  const [lanes, setLanes] = useState<Lanes | null>(null);
  const lanesRef = useRef<Lanes | null>(null);
  lanesRef.current = lanes;
  const origin = useRef<{ column: Column; index: number } | null>(null);
  const lastOver = useRef<UniqueIdentifier | null>(null);
  const crossedColumn = useRef(false);
  // The board data a drop was made against; the lanes hold until the data is something newer.
  const droppedOn = useRef<Card[] | null>(null);
  const [doneExpanded, setDoneExpanded] = useState(false);
  // Done starts as a narrow strip on every Board until opened there. `doneToggled` lets the switch
  // animate when a person makes it, and not when the page loads.
  const [doneOpen, setDoneOpen] = useState(() => readDoneOpen(browserStorage(), slug));
  const [doneToggled, setDoneToggled] = useState(false);
  useEffect(() => {
    setDoneOpen(readDoneOpen(browserStorage(), slug));
    setDoneToggled(false);
  }, [slug]);
  const toggleDone = useCallback(() => {
    writeDoneOpen(browserStorage(), slug, !doneOpen);
    setDoneOpen(!doneOpen);
    setDoneToggled(true);
  }, [doneOpen, slug]);
  // Set as a card is dropped: whether it went onto a collapsed Done, which it disappears into, and the
  // card, whose hidden place in the strip the drop animation lands on until the move is saved.
  const tuck = useRef(false);
  const dropped = useRef<string | null>(null);
  const cardDrop = useMemo(() => dropAnimation(tuck), []);
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
  // Left and Right carry a card picked up with the keyboard to the next column along. Left to the
  // sortable defaults, they find the card's own column nearest, since it sits a few pixels further
  // out than the card, and the card never leaves it.
  const keyboardCoordinates: KeyboardCoordinateGetter = useCallback((event, args) => {
    const step = event.code === "ArrowLeft" ? -1 : event.code === "ArrowRight" ? 1 : 0;
    const current = lanesRef.current;
    const column = step && current ? laneOf(current, String(args.active)) : null;
    if (!column) return sortableKeyboardCoordinates(event, args);
    event.preventDefault();
    const next = COLUMNS[COLUMNS.indexOf(column) + step];
    const rect = next ? args.context.droppableRects.get(columnDropId(next)) : undefined;
    return rect ? { x: rect.left + 8, y: args.currentCoordinates.y } : args.currentCoordinates;
  }, []);
  // A touch has to rest on a card before it drags, so a swipe still scrolls the board.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: keyboardCoordinates, keyboardCodes: KEYBOARD_CODES }),
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
  // What the columns show: the lanes while a drag holds them, the board data otherwise.
  const shown = useMemo(() => {
    if (!lanes) return byColumn;
    const byId = new Map((board.data?.cards ?? []).map((c) => [c.id, c]));
    const out = {} as Record<Column, Card[]>;
    for (const col of COLUMNS) out[col] = lanes[col].map((id) => byId.get(id)).filter((c): c is Card => Boolean(c));
    return out;
  }, [lanes, byColumn, board.data?.cards]);
  const targetColumn = activeId && lanes ? laneOf(lanes, activeId) : null;

  // The board data has caught up with a drop, or a failed move has put the card back: the lanes let go.
  const cards = board.data?.cards;
  useEffect(() => {
    if (droppedOn.current && cards !== droppedOn.current) {
      droppedOn.current = null;
      setLanes(null);
    }
  }, [cards]);
  // Crossing a column shifts the layout under the pointer for a frame; the collision check waits it out.
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      crossedColumn.current = false;
    });
    return () => cancelAnimationFrame(frame);
  }, [lanes]);

  // The pointer decides where a card goes, since it is what a person aims with; the card's rectangle
  // stands in for a keyboard drag. Over a column that holds cards, the nearest card inside it is the
  // target, so the gap opens where the pointer is rather than at the column's end.
  const collisionDetection: CollisionDetection = useCallback(
    (args) => {
      const pointer = pointerWithin(args);
      let overId = getFirstCollision(pointer.length > 0 ? pointer : rectIntersection(args), "id");
      if (overId != null) {
        const current = lanesRef.current;
        const column = current && String(overId).startsWith("col:") ? laneOf(current, String(overId)) : null;
        if (current && column && current[column].length > 0) {
          const inside = new Set(current[column]);
          overId = closestCenter({ ...args, droppableContainers: args.droppableContainers.filter((c) => inside.has(String(c.id))) })[0]?.id ?? overId;
        }
        lastOver.current = overId;
        return [{ id: overId }];
      }
      if (crossedColumn.current) lastOver.current = args.active.id;
      return lastOver.current != null ? [{ id: lastOver.current }] : [];
    },
    [],
  );

  const onDragStart = useCallback(
    (e: DragStartEvent) => {
      const id = String(e.active.id);
      const snapshot = {} as Lanes;
      for (const col of COLUMNS) snapshot[col] = byColumn[col].map((c) => c.id);
      const column = laneOf(snapshot, id);
      origin.current = column ? { column, index: snapshot[column].indexOf(id) } : null;
      lastOver.current = null;
      droppedOn.current = null;
      setLanes(snapshot);
      setActiveId(id);
    },
    [byColumn],
  );
  const onDragOver = useCallback((e: DragOverEvent) => {
    const { active, over } = e;
    if (!over || over.id === active.id) return;
    const translated = active.rect.current.translated;
    const pastMiddle = Boolean(translated && translated.top + translated.height / 2 > over.rect.top + over.rect.height / 2);
    setLanes((current) => {
      const next = current && moveAcross(current, String(active.id), String(over.id), pastMiddle);
      if (!next) return current;
      crossedColumn.current = true;
      return next;
    });
  }, []);
  const onDragCancel = useCallback(() => {
    droppedOn.current = null;
    tuck.current = false;
    dropped.current = null;
    setActiveId(null);
    setLanes(null);
  }, []);
  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const { active, over } = e;
      const id = String(active.id);
      const card = board.data?.cards.find((c) => c.id === id);
      const current = lanesRef.current;
      if (!over || !card || !current || !board.data) return onDragCancel();
      const settled = settleWithin(current, id, String(over.id));
      const spot = dropSpot(settled, id);
      const from = origin.current;
      // Put down where it was picked up: nothing to send.
      if (!spot || (from && spot.column === from.column && settled[spot.column].indexOf(id) === from.index)) return onDragCancel();
      // Placed among every Card in the column, not only those the filter or the folded Done shows:
      // a position worked out from the visible ones alone can land on a hidden Card's.
      const whole = board.data.cards.filter((c) => c.column === spot.column).sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
      const position = placeBefore(whole, id, spot.beforeId);
      // The lanes hold the dropped order until the board data shows it, so the card stays put.
      droppedOn.current = board.data.cards;
      tuck.current = spot.column === "done" && !doneOpen;
      dropped.current = id;
      setLanes(settled);
      setActiveId(null);
      // The card springs back on a refusal, which says nothing about why without this.
      move.mutate({ id, column: spot.column, position, revision: card.revision }, { onError: (err) => toast(`“${card.title}” was not moved. ${err.message}`) });
    },
    [board.data, move, onDragCancel, doneOpen],
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
          </div>
          {helpButton("max-sm:hidden")}
        </div>
      </div>
      <HowItWorks open={showHelp} agent={agent} onClose={closeHelp} />
      <DndContext
        sensors={sensors}
        collisionDetection={collisionDetection}
        measuring={MEASURING}
        accessibility={{ screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragEnd={onDragEnd}
        onDragCancel={onDragCancel}
      >
        {/* On a phone each swipe lands one column against the gutter. Snapping pauses while a card is
            dragged, so the auto-scroll toward the next column is not pulled back. */}
        <div className={cx("flex min-h-0 flex-1 scroll-px-4 gap-3 overflow-x-auto overscroll-x-contain px-4 pb-4 pt-3", activeId ? "snap-none" : "snap-x snap-mandatory sm:snap-none")}>
          {COLUMNS.map((column) => (
            <ColumnLane
              key={column}
              column={column}
              cards={shown[column]}
              people={people}
              agent={agent}
              viewer={viewer}
              onOpen={openCard}
              onNew={() => setCreating(true)}
              canAdd={column === "inbox"}
              filtering={filtering}
              dragging={lanes !== null}
              targeted={targetColumn === column}
              collapse={column === "done" ? { open: doneOpen, onToggle: toggleDone, activeId: activeId ?? (lanes ? dropped.current : null), toggled: doneToggled } : undefined}
              fold={column === "done" ? { hidden: doneHidden, expanded: doneExpanded, onToggle: () => setDoneExpanded((x) => !x) } : undefined}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={reduce ? null : cardDrop}>
          {activeCard ? <CardTile card={activeCard} creator={activeCard.creatorId ? people.get(activeCard.creatorId) : undefined} agent={agent} questionIsMine={waitsOn(activeCard, viewer)} overlay /> : null}
        </DragOverlay>
      </DndContext>
      <NewCardDialog slug={slug} open={creating} onClose={() => setCreating(false)} isAdmin={Boolean(isAdmin)} onCreated={openCard} />
      <CardSheet slug={slug} cardId={cardId ?? null} view={board.data} onClose={closeCard} />
    </div>
  );
}
