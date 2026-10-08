import { Button } from "../components/ui";
import { Wordmark } from "../components/Wordmark";

// What shows when the page loaded but the API did not answer it.
export function UnreachablePage() {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-6 p-6 text-center">
      <Wordmark />
      <div className="max-w-sm">
        <h1 className="text-lg font-semibold text-ink">kardboard can't reach its server</h1>
        <p className="mt-2 text-sm text-ink-muted">The app loaded but the API did not answer. Try again in a moment.</p>
      </div>
      <Button onClick={() => window.location.reload()}>Try again</Button>
    </div>
  );
}
