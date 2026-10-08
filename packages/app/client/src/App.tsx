import { Navigate, Route, Routes } from "react-router";
import { useMe } from "./lib/api";
import { OverviewPage } from "./routes/OverviewPage";
import { BoardPage } from "./routes/BoardPage";
import { SettingsPage } from "./routes/settings/SettingsPage";
import { UnreachablePage } from "./routes/UnreachablePage";
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
  // typed.
  if (!me.data) return <UnreachablePage />;
  return (
    <Shell me={me.data}>
      <Routes>
        <Route path="/" element={<OverviewPage />} />
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
