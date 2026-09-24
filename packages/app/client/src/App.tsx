import { Navigate, Route, Routes } from "react-router";
import { ApiError, useMe } from "./lib/api";
import { BoardsPage } from "./routes/BoardsPage";
import { BoardPage } from "./routes/BoardPage";
import { AdminPage } from "./routes/admin/AdminPage";
import { NotInvitedPage } from "./routes/NotInvitedPage";
import { PreviewAuthPage } from "./routes/PreviewAuthPage";
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
        <Route path="/preview-auth" element={<PreviewAuthPage />} />
        <Route path="/b/:slug" element={<BoardPage />} />
        <Route path="/b/:slug/c/:cardId" element={<BoardPage />} />
        <Route path="/admin/*" element={me.data.user.role === "admin" ? <AdminPage /> : <Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
