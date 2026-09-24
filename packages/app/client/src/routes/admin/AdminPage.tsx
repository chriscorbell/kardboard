import { NavLink, Navigate, Route, Routes } from "react-router";
import { cx } from "../../components/ui";
import { UsersTab } from "./UsersTab";
import { BoardsTab } from "./BoardsTab";
import { AgentTab } from "./AgentTab";
import { SessionsTab } from "./SessionsTab";
import { BackupsTab } from "./BackupsTab";

const TABS = [
  { to: "/admin/users", label: "Users" },
  { to: "/admin/boards", label: "Boards" },
  { to: "/admin/agent", label: "Agent" },
  { to: "/admin/sessions", label: "Sessions" },
  { to: "/admin/backups", label: "Backups" },
];

export function AdminPage() {
  return (
    <div className="flex h-full min-h-0 flex-col sm:flex-row">
      {/* A side rail from sm up; below it, a row of tabs that scrolls sideways if it has to. */}
      <nav aria-label="Admin" className="shrink-0 border-b border-line px-2 py-2 sm:w-52 sm:border-b-0 sm:border-r sm:p-3">
        <p className="mb-2 hidden px-2 pt-1 text-[11px] font-semibold uppercase tracking-wide text-ink-faint sm:block">Admin</p>
        <ul className="flex gap-1 overflow-x-auto sm:flex-col sm:gap-0.5 sm:overflow-visible">
          {TABS.map((t) => (
            <li key={t.to} className="shrink-0">
              <NavLink
                to={t.to}
                className={({ isActive }) =>
                  cx("block whitespace-nowrap rounded-control px-2.5 py-1.5 text-[13.5px] transition-colors", isActive ? "bg-raised font-medium text-ink" : "text-ink-muted hover:bg-raised/60 hover:text-ink")
                }
              >
                {t.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <div className="min-h-0 min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl px-4 py-5 sm:px-8 sm:py-7">
          <Routes>
            <Route index element={<Navigate to="users" replace />} />
            <Route path="users" element={<UsersTab />} />
            <Route path="boards" element={<BoardsTab />} />
            <Route path="agent" element={<AgentTab />} />
            <Route path="sessions" element={<SessionsTab />} />
            <Route path="backups" element={<BackupsTab />} />
          </Routes>
        </div>
      </div>
    </div>
  );
}

export function TabHeader({ title, body, action }: { title: string; body: string; action?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-start gap-4">
      <div className="min-w-0 flex-1">
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-[13px] text-ink-muted">{body}</p>
      </div>
      {action}
    </div>
  );
}
