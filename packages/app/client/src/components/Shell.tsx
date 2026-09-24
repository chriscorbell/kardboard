import { useState, type ReactNode } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router";
import { ChevronDown, LogOut, Mail, Settings2, UserRound } from "lucide-react";
import type { Me } from "@kardboard/shared";
import { useBoards } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Avatar, cx } from "./ui";
import { Wordmark } from "./Wordmark";
import { Menu } from "./Menu";
import { Notifications } from "./Notifications";
import { EmailPreferences } from "./EmailPreferences";
import { Toaster } from "./Toaster";

export function Shell({ me, children }: { me: Me; children: ReactNode }) {
  const boards = useBoards();
  const navigate = useNavigate();
  const location = useLocation();
  const slug = /^\/b\/([^/]+)/.exec(location.pathname)?.[1];
  const { signOut, mode, openProfile } = useAuth();
  const current = boards.data?.find((b) => b.slug === slug);
  const isAdmin = location.pathname.startsWith("/admin");
  const [emailOpen, setEmailOpen] = useState(false);

  // On a phone the wordmark keeps only its mark and the board name gives way (truncating) before
  // the bell or the account menu does: those two must always be reachable.
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
                    <span className="truncate">{current?.name ?? (isAdmin ? "Admin" : "Boards")}</span>
                    <ChevronDown className="size-4 shrink-0 text-ink-faint" strokeWidth={1.75} />
                  </button>
                }
                items={[
                  ...boards.data.map((b) => ({ label: b.name, onSelect: () => navigate(`/b/${b.slug}`), active: b.id === current?.id })),
                  { label: "All boards", onSelect: () => navigate("/"), separator: true },
                ]}
              />
            </div>
          </>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {me.user.role === "admin" ? (
            <NavLink
              to="/admin"
              aria-label="Admin"
              className={({ isActive }) =>
                cx("inline-flex h-8 items-center gap-1.5 rounded-control px-2 text-[13px] font-medium transition-colors sm:px-2.5", isActive ? "bg-raised text-ink" : "text-ink-muted hover:bg-raised hover:text-ink")
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
              { label: "Email notifications", icon: <Mail className="size-4" strokeWidth={1.75} />, onSelect: () => setEmailOpen(true), separator: true },
              ...(mode === "clerk" && openProfile ? [{ label: "Manage account", icon: <UserRound className="size-4" strokeWidth={1.75} />, onSelect: () => openProfile() }] : []),
              ...(mode === "clerk" ? [{ label: "Sign out", icon: <LogOut className="size-4" strokeWidth={1.75} />, onSelect: () => void signOut() }] : []),
            ]}
          />
        </div>
      </header>
      <main className="min-h-0 flex-1">{children}</main>
      <EmailPreferences me={me} open={emailOpen} onClose={() => setEmailOpen(false)} />
      <Toaster />
      {mode === "dev" ? (
        <div className="pointer-events-none fixed bottom-3 left-3 z-40 hidden rounded-full sm:block border border-line bg-surface/90 px-2.5 py-1 font-mono text-[11px] text-ink-faint backdrop-blur">
          dev auth as <Link to="/admin" className="pointer-events-auto text-ink-muted">{me.user.handle}</Link>
        </div>
      ) : null}
    </div>
  );
}
