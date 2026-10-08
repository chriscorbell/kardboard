import type { ReactNode } from "react";
import { NavLink, useLocation, useNavigate } from "react-router";
import { ChevronDown, Settings2 } from "lucide-react";
import type { Me } from "@kardboard/shared";
import { useBoards } from "../lib/api";
import { Avatar, cx } from "./ui";
import { Wordmark } from "./Wordmark";
import { Menu } from "./Menu";
import { Toaster } from "./Toaster";

export function Shell({ me, children }: { me: Me; children: ReactNode }) {
  const boards = useBoards();
  const navigate = useNavigate();
  const location = useLocation();
  const slug = /^\/b\/([^/]+)/.exec(location.pathname)?.[1];
  const current = boards.data?.find((b) => b.slug === slug);
  const inSettings = location.pathname.startsWith("/settings");

  // On a phone the wordmark keeps only its mark and the board name gives way (truncating) before
  // Settings or the account menu does: those two must always be reachable.
  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-line bg-bg px-4 sm:gap-3">
        <Wordmark compact />
        {boards.data && boards.data.length > 0 ? (
          <>
            <span className="shrink-0 text-ink-faint">/</span>
            <div className="min-w-0">
              <Menu
                trigger={
                  <button className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-control px-2 text-sm font-medium text-ink transition-colors hover:bg-raised">
                    <span className="truncate">{current?.name ?? (inSettings ? "Settings" : "Overview")}</span>
                    <ChevronDown className="size-4 shrink-0 text-ink-faint" strokeWidth={1.75} />
                  </button>
                }
                items={[
                  ...boards.data.map((b) => ({ label: b.name, onSelect: () => navigate(`/b/${b.slug}`), active: b.id === current?.id })),
                  { label: "Overview", onSelect: () => navigate("/"), separator: true },
                ]}
              />
            </div>
          </>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          <NavLink
            to="/settings"
            aria-label="Settings"
            className={({ isActive }) =>
              cx("inline-flex h-8 items-center gap-1.5 rounded-control px-2 text-[13px] font-medium transition-colors sm:px-2.5", isActive ? "bg-raised text-ink" : "text-ink-muted hover:bg-raised hover:text-ink")
            }
          >
            <Settings2 className="size-4" strokeWidth={1.75} />
            <span className="hidden sm:inline">Settings</span>
          </NavLink>
          <span className="ml-1 inline-flex p-0.5" title={me.user.name}>
            <Avatar name={me.user.name} url={me.user.avatarUrl} size={28} />
          </span>
        </div>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
      <Toaster />
    </div>
  );
}
