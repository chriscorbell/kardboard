import { useCallback, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { closestCorners, DndContext, DragOverlay, PointerSensor, useDroppable, useSensor, useSensors, type DragEndEvent, type DragStartEvent } from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Plus } from "lucide-react";
import { COLUMNS, COLUMN_LABELS, type AgentProfile, type Card, type Column, type User } from "@kardboard/shared";
import { useBoard, useMe, useMoveCard } from "../lib/api";
import { useBoardEvents } from "../lib/realtime";
import { Avatar, Button, cx, IconButton, Skeleton } from "../components/ui";
import { CardTile, WorkingDot } from "./board/CardTile";
import { NewCardDialog } from "./board/NewCardDialog";
import { CardSheet } from "./board/CardSheet";
import { COLUMN_HINTS } from "./board/columns";

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
      className="cursor-grab active:cursor-grabbing"
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === "Enter") onOpen();
      }}
      {...attributes}
      {...listeners}
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
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 6 } }));

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
      const targetColumn = overId.startsWith("col:") ? (overId.slice(4) as Column) : (board.data.cards.find((c) => c.id === overId)?.column ?? card.column);
      const lane = byColumn[targetColumn].filter((c) => c.id !== card.id);
      let index = lane.length;
      if (!overId.startsWith("col:")) {
        const overIndex = lane.findIndex((c) => c.id === overId);
        if (overIndex >= 0) {
          const sameLane = card.column === targetColumn;
          const fromIndex = byColumn[targetColumn].findIndex((c) => c.id === card.id);
          index = sameLane && fromIndex < overIndex ? overIndex + 1 : overIndex;
        }
      }
      const before = lane[index - 1]?.position;
      const after = lane[index]?.position;
      let position: number;
      if (before === undefined && after === undefined) position = 1000;
      else if (before === undefined) position = after! - 1000;
      else if (after === undefined) position = before + 1000;
      else position = (before + after) / 2;
      if (targetColumn === card.column && position === card.position) return;
      move.mutate({ id: card.id, column: targetColumn, position, revision: card.revision });
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
  if (board.isError || !board.data) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-muted">
        This board does not exist or you do not have access to it.
      </div>
    );
  }
  const isAdmin = me.data?.user.role === "admin";
  const agent = board.data.agent;
  const agentName = agent.name;

  return (
    <div className="flex h-full flex-col">
      <div className="flex h-11 shrink-0 items-center gap-3 border-b border-line px-4">
        <Button size="sm" variant="primary" icon={<Plus className="size-3.5" strokeWidth={2} />} onClick={() => setCreating(true)}>
          New card
        </Button>
        <div className="ml-auto flex items-center gap-2 text-[12.5px] text-ink-muted">
          {activeSessions.length > 0 ? (
            <span className="inline-flex items-center gap-2 rounded-full border border-accent/30 bg-accent-soft py-1 pl-1 pr-2.5 text-accent">
              <Avatar name={agent.name} url={agent.avatarUrl} size={18} tone="agent" />
              <WorkingDot />
              {agentName} is working on {activeSessions.length === 1 ? "1 card" : `${activeSessions.length} cards`}
            </span>
          ) : (
            <span className="inline-flex items-center gap-2 rounded-full border border-line py-1 pl-1 pr-2.5">
              <Avatar name={agent.name} url={agent.avatarUrl} size={18} tone="agent" />
              <span className="size-2 rounded-full bg-ink-faint" />
              {agentName} is idle
            </span>
          )}
        </div>
      </div>
      <DndContext sensors={sensors} collisionDetection={closestCorners} onDragStart={onDragStart} onDragEnd={onDragEnd} onDragCancel={() => setActiveId(null)}>
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
