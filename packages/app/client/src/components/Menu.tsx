import { type ReactNode } from "react";
import { Popover } from "./Popover";
import { cx } from "./ui";

export type MenuItem = { label: string; onSelect?: () => void; icon?: ReactNode; active?: boolean; disabled?: boolean; separator?: boolean; danger?: boolean };

export function Menu({ trigger, items, align = "left" }: { trigger: ReactNode; items: MenuItem[]; align?: "left" | "right" }) {
  return (
    <Popover trigger={trigger} align={align} role="menu" className="min-w-48 p-1">
      {(close) =>
        items.map((item, i) => (
          <div key={i}>
            {item.separator ? <div className="my-1 border-t border-line" /> : null}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              disabled={item.disabled}
              onClick={() => {
                item.onSelect?.();
                close();
              }}
              className={cx(
                "flex w-full items-center gap-2 rounded-[6px] px-2.5 py-1.5 text-left text-[13px] transition-colors focus-visible:outline-none",
                item.disabled ? "cursor-default text-ink-faint" : item.danger ? "text-danger hover:bg-[rgba(217,130,116,0.1)] focus-visible:bg-[rgba(217,130,116,0.1)]" : "text-ink hover:bg-overlay focus-visible:bg-overlay",
                item.active && "text-accent",
              )}
            >
              {item.icon}
              <span className="truncate">{item.label}</span>
            </button>
          </div>
        ))
      }
    </Popover>
  );
}
