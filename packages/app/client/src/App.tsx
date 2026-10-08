import { Navigate, Route, Routes } from "react-router";
import { ApiError, useMe } from "./lib/api";
import { BoardsPage } from "./routes/BoardsPage";
import { BoardPage } from "./routes/BoardPage";
import { SettingsPage } from "./routes/settings/SettingsPage";
import { NotInvitedPage } from "./routes/NotInvitedPage";
import { Shell } from "./components/Shell";
import { Skeleton } from "./components/ui";

export function App() {
  const me = useMe();
  if (me.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <Skeleton className="h-2 w-24" />
      </div>
    );
  }
  // A failed background refetch keeps the page: unmounting it would throw away whatever is being
  // typed. Only a 403 overrides loaded data, because it means access was revoked.
  const err = me.error;
  if (!me.data || (err instanceof ApiError && err.status === 403)) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 401)) return <NotInvitedPage reason={err.status === 401 ? "unauthenticated" : "not_invited"} />;
    return <NotInvitedPage reason="error" />;
  }
  return (
    <Shell me={me.data}>
      <Routes>
        <Route path="/" element={<BoardsPage />} />
        <Route path="/b/:slug" element={<BoardPage />} />
        <Route path="/b/:slug/c/:cardId" element={<BoardPage />} />
        <Route path="/settings/*" element={<SettingsPage />} />
        {/* Where Settings lived when it was the admin panel, so old links and bookmarks still land. */}
        <Route path="/admin/*" element={<Navigate to="/settings" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
