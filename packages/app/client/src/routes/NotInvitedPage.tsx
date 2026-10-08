import { Button } from "../components/ui";
import { Wordmark } from "../components/Wordmark";

// What someone sees when the app will not let them in: kardboard opens only through Tailscale, and
// only for one Tailscale login.
export function NotInvitedPage({ reason }: { reason: "not_allowed" | "unauthenticated" | "error" }) {
  const copy = {
    not_allowed: { title: "This Tailscale account isn't the one", body: "This kardboard belongs to one person and opens only for their Tailscale login." },
    unauthenticated: { title: "Open kardboard through Tailscale", body: "This address did not come through Tailscale, so kardboard cannot tell who you are. Open it at its tailnet address." },
    error: { title: "kardboard can't reach its server", body: "The app loaded but the API did not answer. Try again in a moment." },
  }[reason];
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 p-6 text-center">
      <Wordmark />
      <div className="max-w-sm">
        <h1 className="text-lg font-semibold text-ink">{copy.title}</h1>
        <p className="mt-2 text-sm text-ink-muted">{copy.body}</p>
      </div>
      <Button onClick={() => window.location.reload()}>Try again</Button>
    </div>
  );
}
