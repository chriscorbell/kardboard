import { useAuth } from "../lib/auth";
import { Button } from "../components/ui";
import { Wordmark } from "../components/Wordmark";

export function NotInvitedPage({ reason }: { reason: "not_invited" | "unauthenticated" | "error" }) {
  const { signOut, mode } = useAuth();
  const copy = {
    not_invited: { title: "This account isn't the one", body: "This kardboard belongs to one person and signs in with their address only. If that's you, sign out and use that address." },
    unauthenticated: { title: "Sign in to continue", body: "Your session has ended. Sign in again to open your boards." },
    error: { title: "kardboard can't reach its server", body: "The app loaded but the API did not answer. Try again in a moment." },
  }[reason];
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 p-6 text-center">
      <Wordmark />
      <div className="max-w-sm">
        <h1 className="text-lg font-semibold text-ink">{copy.title}</h1>
        <p className="mt-2 text-sm text-ink-muted">{copy.body}</p>
      </div>
      <div className="flex gap-2">
        <Button onClick={() => window.location.reload()}>Try again</Button>
        {mode === "clerk" ? <Button variant="ghost" onClick={() => void signOut()}>Sign out</Button> : null}
      </div>
    </div>
  );
}
