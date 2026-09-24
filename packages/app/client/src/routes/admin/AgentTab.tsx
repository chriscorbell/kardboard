import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MAX_WALL_CLOCK_MINUTES, MIN_WALL_CLOCK_MINUTES, type Settings } from "@kardboard/shared";
import { keys, request, useAdminSettings } from "../../lib/api";
import { Avatar, Button, ErrorState, Field, Input, Skeleton } from "../../components/ui";
import { TabHeader } from "./AdminPage";

export function AgentTab() {
  const settings = useAdminSettings();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Settings | null>(null);
  useEffect(() => {
    if (settings.data && !draft) setDraft(settings.data);
  }, [settings.data, draft]);
  const save = useMutation({
    mutationFn: (d: Settings) => request<Settings>("/admin/settings", { method: "PATCH", body: JSON.stringify(d) }),
    onSuccess: (d) => {
      qc.setQueryData(keys.adminSettings, d);
      void qc.invalidateQueries({ queryKey: keys.me });
      setDraft(d);
    },
  });
  if (!draft) {
    if (settings.isError) return <ErrorState title="Could not load the agent settings." error={settings.error} onRetry={() => void settings.refetch()} retrying={settings.isFetching} />;
    return <Skeleton className="h-40" />;
  }
  return (
    <>
      <TabHeader title="Agent" body="One identity acts on every board. Members will address it by this name, so pick something you're happy to see in comment history." />
      <form
        className="flex max-w-lg flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(draft);
        }}
      >
        <div className="flex items-center gap-4">
          <Avatar name={draft.agentName} url={draft.agentAvatarUrl} size={48} tone="agent" />
          <div className="grid flex-1 gap-3">
            <Field label="Name">
              <Input value={draft.agentName} onChange={(e) => setDraft({ ...draft, agentName: e.target.value })} maxLength={40} />
            </Field>
            <Field label="Avatar URL" hint="A square image. The default is the built-in Milo avatar at /brand/milo.png.">
              <Input type="text" value={draft.agentAvatarUrl ?? ""} onChange={(e) => setDraft({ ...draft, agentAvatarUrl: e.target.value || null })} placeholder="https://" />
            </Field>
          </div>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Global concurrent sessions" hint="Across all boards. Protects your own interactive use of the subscription.">
            <Input type="number" min={1} max={20} value={draft.globalMaxConcurrentSessions} onChange={(e) => setDraft({ ...draft, globalMaxConcurrentSessions: Number(e.target.value) })} />
          </Field>
          <Field label="Session wall clock (minutes)" hint={`A session that runs longer is stopped. At most ${MAX_WALL_CLOCK_MINUTES}, since the session's GitHub token lasts one hour.`}>
            <Input type="number" min={MIN_WALL_CLOCK_MINUTES} max={MAX_WALL_CLOCK_MINUTES} value={draft.sessionWallClockMinutes} onChange={(e) => setDraft({ ...draft, sessionWallClockMinutes: Number(e.target.value) })} />
          </Field>
        </div>
        <label className="flex items-start gap-2 text-[13px] text-ink-muted">
          <input
            type="checkbox"
            checked={draft.providerFallback}
            onChange={(e) => setDraft({ ...draft, providerFallback: e.target.checked })}
            className="mt-[3px] accent-accent"
          />
          <span>
            Provider fallback: when a session's provider runs out of usage, pick the card up again on the other one. Both subscriptions keep their credential in the egress
            proxy, so a fallback does not move a token anywhere. The board's model is left to the other provider's default, since a model name belongs to one of them.
          </span>
        </label>
        {save.isError ? <p className="text-[13px] text-danger">{save.error.message}</p> : null}
        <div>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
          {save.isSuccess ? <span className="ml-3 text-[12.5px] text-ink-muted">Saved.</span> : null}
        </div>
      </form>
    </>
  );
}
