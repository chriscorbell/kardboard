import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { Pause, Play } from "lucide-react";
import type { AgentProfile, Board } from "@kardboard/shared";
import { useSetBoardPaused } from "../../lib/api";
import { Avatar, Button, cx } from "../../components/ui";
import { WorkingDot } from "./CardTile";
import { agentPill } from "./sessionStatus";

// The toolbar's word on the Agent: working, idle, or paused on this Board. Everyone sees the state;
// the Admin also gets the switch beside it. The Board's event stream carries a change of the switch,
// so the pill follows it live for everyone else.
export function AgentPill({ slug, board, agent, working, isAdmin }: { slug: string; board: Board; agent: AgentProfile; working: number; isAdmin: boolean }) {
  const reduce = useReducedMotion();
  const setPaused = useSetBoardPaused(slug);
  const state = agentPill({ agentName: agent.name, paused: board.paused, working });
  return (
    <>
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={state.tone}
          initial={reduce ? false : { opacity: 0, scale: 0.97 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, transition: { duration: reduce ? 0 : 0.12 } }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className={cx(
            "inline-flex items-center gap-2 whitespace-nowrap rounded-full border py-1 pl-1 pr-2.5",
            state.tone === "working" ? "border-accent/30 bg-accent-soft text-accent" : state.tone === "paused" ? "border-line-strong bg-raised text-ink" : "border-line",
          )}
        >
          <Avatar name={agent.name} url={agent.avatarUrl} size={18} tone="agent" />
          {state.tone === "working" ? <WorkingDot /> : state.tone === "paused" ? <Pause className="size-3 text-warn" strokeWidth={2.25} aria-hidden="true" /> : <span className="size-2 rounded-full bg-ink-faint" />}
          {state.short === state.label ? (
            state.label
          ) : (
            <>
              <span className="sm:hidden">{state.short}</span>
              <span className="hidden sm:inline">{state.label}</span>
            </>
          )}
        </motion.span>
      </AnimatePresence>
      {isAdmin ? (
        <Button
          size="sm"
          variant="ghost"
          loading={setPaused.isPending}
          icon={board.paused ? <Play className="size-3.5" strokeWidth={2} /> : <Pause className="size-3.5" strokeWidth={2} />}
          onClick={() => setPaused.mutate({ boardId: board.id, paused: !board.paused })}
          aria-label={board.paused ? `Resume ${agent.name} on this board` : `Pause ${agent.name} on this board`}
          title={setPaused.error ? setPaused.error.message : board.paused ? `Resume ${agent.name} on this board` : `Pause ${agent.name} on this board`}
          className={cx(setPaused.error && "text-danger")}
        >
          <span className="hidden sm:inline">{board.paused ? "Resume" : "Pause"}</span>
        </Button>
      ) : null}
    </>
  );
}
