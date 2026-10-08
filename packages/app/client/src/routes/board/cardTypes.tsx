import { Bug, Lightbulb, Sparkles, SquareCheck, Wrench, type LucideIcon } from "lucide-react";
import { CARD_TYPE_LABELS, type CardType } from "@kardboard/shared";
import { cx } from "../../components/ui";

// How each Card type reads on the Board: an icon and a color of its own, the same on every Board, so a
// column of bugs and ideas sorts itself at a glance.
export const CARD_TYPE_LOOK: Record<CardType, { icon: LucideIcon; text: string; soft: string }> = {
  task: { icon: SquareCheck, text: "text-type-task", soft: "bg-type-task/12 border-type-task/30" },
  bug: { icon: Bug, text: "text-type-bug", soft: "bg-type-bug/12 border-type-bug/30" },
  feature: { icon: Sparkles, text: "text-type-feature", soft: "bg-type-feature/12 border-type-feature/30" },
  idea: { icon: Lightbulb, text: "text-type-idea", soft: "bg-type-idea/12 border-type-idea/30" },
  chore: { icon: Wrench, text: "text-type-chore", soft: "bg-type-chore/12 border-type-chore/30" },
};

/** The type's icon in its color, with its name beside it unless `iconOnly`. */
export function TypeLabel({ type, iconOnly = false, className }: { type: CardType; iconOnly?: boolean; className?: string }) {
  const look = CARD_TYPE_LOOK[type];
  const Icon = look.icon;
  return (
    <span className={cx("inline-flex items-center gap-1 font-medium", look.text, className)} title={iconOnly ? CARD_TYPE_LABELS[type] : undefined}>
      <Icon className="size-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
      {iconOnly ? <span className="sr-only">{CARD_TYPE_LABELS[type]}</span> : CARD_TYPE_LABELS[type]}
    </span>
  );
}
