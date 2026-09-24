import type { Provider, ProviderStatus } from "@kardboard/shared";
import { useAdminLimits } from "../../lib/api";
import { Chip, ErrorState, Skeleton } from "../../components/ui";
import { absoluteTime, relativeTime } from "../../lib/format";
import { providerState } from "./providerState";

const NAME: Record<Provider, string> = { claude: "Claude Code", codex: "Codex" };

// What the egress proxy last saw of each subscription. Only the proxy sees a provider's own answers,
// so this is the one place a usage window or a rejected credential shows before Sessions fail on it.
export function ProvidersStatus() {
  const limits = useAdminLimits();
  const view = limits.data;
  const now = Date.now();
  return (
    <section aria-labelledby="providers-heading" className="mt-10 max-w-lg border-t border-line pt-6">
      <h2 id="providers-heading" className="text-sm font-semibold tracking-tight">
        Providers
      </h2>
      <p className="mt-1 text-[13px] text-ink-muted">What the egress proxy has seen of each subscription since it last started.</p>
      {limits.isPending ? (
        <Skeleton className="mt-4 h-24" />
      ) : !view ? (
        <ErrorState compact className="mt-4" title="Could not read provider status." error={limits.error} onRetry={() => void limits.refetch()} retrying={limits.isFetching} />
      ) : view.egress === "unconfigured" ? (
        <p className="mt-4 text-[13px] text-ink-muted">No egress proxy is configured, so usage limits and credentials are not tracked.</p>
      ) : view.egress === "unreachable" ? (
        <ErrorState compact className="mt-4" title="The egress proxy did not answer." onRetry={() => void limits.refetch()} retrying={limits.isFetching} />
      ) : (
        <>
          <ul className="mt-4 divide-y divide-line rounded-card border border-line bg-surface">
            {view.providers.map((p) => (
              <ProviderRow key={p.provider} status={p} now={now} />
            ))}
          </ul>
          {view.refusals.last ? (
            <p className="mt-3 text-[12.5px] text-ink-muted" title={absoluteTime(view.refusals.last.at)}>
              The proxy has refused {view.refusals.count} {view.refusals.count === 1 ? "call" : "calls"} that are not on its allowlist. The last was{" "}
              <span className="font-mono text-[12px] text-ink">
                {view.refusals.last.method} {view.refusals.last.path}
              </span>{" "}
              from {NAME[view.refusals.last.provider]}, {relativeTime(view.refusals.last.at)}.
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}

function ProviderRow({ status, now }: { status: ProviderStatus; now: number }) {
  const state = providerState(status, now);
  const failure = status.authFailure;
  return (
    <li className="px-4 py-3">
      <div className="flex items-center gap-2">
        <span className="min-w-0 flex-1 text-[13.5px] font-medium text-ink">{NAME[status.provider]}</span>
        <Chip tone={state.tone}>{state.label}</Chip>
      </div>
      {failure ? (
        <p className="mt-1 text-[12.5px] text-danger" title={absoluteTime(failure.at)}>
          {failure.reason}
          {failure.status && !failure.reason.includes(String(failure.status)) ? ` (${failure.status})` : ""}, {relativeTime(failure.at)}. Every session on it fails until the credential is replaced.
        </p>
      ) : null}
      {state.reopensAt ? (
        <p className="mt-1 text-[12.5px] text-ink-muted">
          Reopens at {new Date(state.reopensAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}, {state.reopensIn}.
        </p>
      ) : status.limit ? (
        <p className="mt-1 text-[12.5px] text-ink-faint" title={absoluteTime(status.limit.at)}>
          Last refused for want of usage {relativeTime(status.limit.at)}.
        </p>
      ) : null}
    </li>
  );
}
