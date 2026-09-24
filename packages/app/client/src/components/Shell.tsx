import { type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { ChevronDown, LogOut, Settings2, UserRound } from "lucide-react";
import type { Me } from "@kardboard/shared";
import { useBoards } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Avatar, cx } from "./ui";
import { Wordmark } from "./Wordmark";
import { Menu } from "./Menu";
import { Notifications } from "./Notifications";

export function Shell({ me, children }: { me: Me; children: ReactNode }) {
  const boards = useBoards();
  const navigate = useNavigate();
  const location = useLocation();
  const slug = /^\/b\/([^/]+)/.exec(location.pathname)?.[1];
  const { signOut, mode, openProfile } = useAuth();
  const current = boards.data?.find((b) => b.slug === slug);
  const isAdmin = location.pathname.startsWith("/admin");

  return (
    <div className="flex h-dvh flex-col overflow-hidden">
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-line bg-bg px-4">
        <Wordmark />
        {boards.data && boards.data.length > 0 ? (
          <>
            <span className="text-ink-faint">/</span>
            <Menu
              trigger={
                <button className="inline-flex h-8 max-w-[40vw] items-center gap-1.5 rounded-control px-2 text-sm font-medium text-ink transition-colors hover:bg-raised sm:max-w-none">
                  <span className="truncate">{current?.name ?? (isAdmin ? "Admin" : "Boards")}</span>
                  <ChevronDown className="size-4 text-ink-faint" strokeWidth={1.75} />
                </button>
              }
              items={[
                ...boards.data.map((b) => ({ label: b.name, onSelect: () => navigate(`/b/${b.slug}`), active: b.id === current?.id })),
                { label: "All boards", onSelect: () => navigate("/"), separator: true },
              ]}
            />
          </>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {me.user.role === "admin" ? (
            <NavLink
              to="/admin"
              className={({ isActive }) =>
                cx("inline-flex h-8 items-center gap-1.5 rounded-control px-2.5 text-[13px] font-medium transition-colors", isActive ? "bg-raised text-ink" : "text-ink-muted hover:bg-raised hover:text-ink")
              }
            >
              <Settings2 className="size-4" strokeWidth={1.75} />
              <span className="hidden sm:inline">Admin</span>
            </NavLink>
          ) : null}
          <Notifications />
          <Menu
            align="right"
            trigger={
              <button className="ml-1 inline-flex items-center gap-2 rounded-full p-0.5 transition-colors hover:bg-raised" aria-label="Account">
                <Avatar name={me.user.name} url={me.user.avatarUrl} size={28} />
              </button>
            }
            items={[
              { label: me.user.email, disabled: true },
              ...(mode === "clerk" && openProfile ? [{ label: "Manage account", icon: <UserRound className="size-4" strokeWidth={1.75} />, onSelect: () => openProfile(), separator: true }] : []),
              ...(mode === "clerk" ? [{ label: "Sign out", icon: <LogOut className="size-4" strokeWidth={1.75} />, onSelect: () => void signOut() }] : []),
            ]}
          />
        </div>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
      {mode === "dev" ? (
        <div className="pointer-events-none fixed bottom-3 left-3 z-40 hidden rounded-full sm:block border border-line bg-surface/90 px-2.5 py-1 font-mono text-[11px] text-ink-faint backdrop-blur">
          dev auth as <Link to="/admin" className="pointer-events-auto text-ink-muted">{me.user.handle}</Link>
        </div>
      ) : null}
    </div>
  );
}
