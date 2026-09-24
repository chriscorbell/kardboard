import { useCallback, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { closestCorners, DndContext, DragOverlay, KeyboardSensor, MouseSensor, TouchSensor, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, sortableKeyboardCoordinates, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Plus, RefreshCw } from "lucide-react";
import { COLUMNS, COLUMN_LABELS, type AgentProfile, type Card, type Column, type User } from "@kardboard/shared";
import { ApiError, useBoard, useMe, useMoveCard } from "../lib/api";
import { useBoardEvents } from "../lib/realtime";
import { Button, cx, ErrorState, IconButton, Skeleton } from "../components/ui";
import { CardTile } from "./board/CardTile";
import { AgentPill } from "./board/AgentPill";
import { NewCardDialog } from "./board/NewCardDialog";
import { CardSheet } from "./board/CardSheet";
import { COLUMN_HINTS } from "./board/columns";
import { dropPlacement } from "./board/dropPlacement";

// Enter opens a card, so only Space picks one up; the instructions read to screen readers say so.
const KEYBOARD_CODES = { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter", "Tab"] };
const SCREEN_READER_INSTRUCTIONS = {
  draggable: "To open a card, press Enter. To move it, press Space to pick it up, use the arrow keys to move it within or between columns, then press Space again to drop it, or Escape to cancel.",
};

function SortableCard({ card, creator, agent, onOpen }: { card: Card; creator: User | undefined; agent: AgentProfile; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: card.id, data: { column: card.column } });
  return (
    <CardTile
      ref={setNodeRef}
      card={card}
      creator={creator}
      agent={agent}
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

function ColumnLane({ column, cards, members, agent, onOpen, onNew, canAdd }: { column: Column; cards: Card[]; members: Map<string, User>; agent: AgentProfile; onOpen: (id: string) => void; onNew: () => void; canAdd: boolean }) {
  const { setNodeRef, isOver } = useDroppable({ id: `col:${column}`, data: { column } });
  const reduce = useReducedMotion();
  return (
    <section className="flex min-w-[84vw] flex-1 snap-start flex-col sm:min-w-[228px] lg:max-w-[320px]" aria-label={COLUMN_LABELS[column]}>
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
                <SortableCard card={card} creator={card.creatorId ? members.get(card.creatorId) : undefined} agent={agent} onOpen={() => onOpen(card.id)} />
              </motion.div>
            ))}
          </AnimatePresence>
        </SortableContext>
        {cards.length === 0 ? <p className="px-2 py-6 text-center text-[12px] leading-relaxed text-ink-faint">{COLUMN_HINTS[column]}</p> : null}
      </div>
    </section>
  );
}

export function BoardPage() {
  const { slug = "", cardId } = useParams();
  const navigate = useNavigate();
  const me = useMe();
  const board = useBoard(slug);
  useBoardEvents(slug);
  const move = useMoveCard(slug);
  const [creating, setCreating] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);
  // A touch has to rest on a card before it drags, so a swipe still scrolls the board.
  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 220, tolerance: 8 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates, keyboardCodes: KEYBOARD_CODES }),
  );

  const members = useMemo(() => new Map((board.data?.members ?? []).map((m) => [m.id, m])), [board.data?.members]);
  const byColumn = useMemo(() => {
    const map: Record<Column, Card[]> = { inbox: [], blocked: [], ready: [], in_progress: [], review: [], done: [] };
    for (const c of board.data?.cards ?? []) map[c.column].push(c);
    for (const col of COLUMNS) map[col].sort((a, b) => a.position - b.position || a.createdAt.localeCompare(b.createdAt));
    return map;
  }, [board.data?.cards]);
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
      const placed = dropPlacement(byColumn[targetColumn], card.id, onColumn ? null : overId);
      if (!placed) return;
      move.mutate({ id: card.id, column: targetColumn, position: placed.position, revision: card.revision });
    },
    [board.data, byColumn, move],
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

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-4">
        <Button size="sm" variant="primary" icon={<Plus className="size-3.5" strokeWidth={2} />} onClick={() => setCreating(true)}>
          New card
        </Button>
        <div className="ml-auto flex items-center gap-2 text-[12.5px] text-ink-muted">
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
      </div>
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        accessibility={{ screenReaderInstructions: SCREEN_READER_INSTRUCTIONS }}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => setActiveId(null)}
      >
        <div className="flex min-h-0 flex-1 snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-4 pt-3 sm:snap-none">
          {COLUMNS.map((column) => (
            <ColumnLane
              key={column}
              column={column}
              cards={byColumn[column]}
              members={members}
              agent={agent}
              onOpen={(id) => navigate(`/b/${slug}/c/${id}`)}
              onNew={() => setCreating(true)}
              canAdd={column === "inbox"}
            />
          ))}
        </div>
        <DragOverlay dropAnimation={{ duration: 180, easing: "cubic-bezier(0.16, 1, 0.3, 1)" }}>
          {activeCard ? <CardTile card={activeCard} creator={activeCard.creatorId ? members.get(activeCard.creatorId) : undefined} agent={agent} overlay className="w-[284px]" /> : null}
        </DragOverlay>
      </DndContext>
      <NewCardDialog slug={slug} open={creating} onClose={() => setCreating(false)} isAdmin={Boolean(isAdmin)} />
      <CardSheet slug={slug} cardId={cardId ?? null} view={board.data} onClose={() => navigate(`/b/${slug}`)} />
    </div>
  );
}
