import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Settings } from "@kardboard/shared";
import { keys, request, useAdminSettings } from "../../lib/api";
import { Avatar, Button, ErrorState, Field, Input, Skeleton } from "../../components/ui";
import { TabHeader } from "./SettingsPage";
import { AccessTokensPanel } from "./AccessTokensPanel";

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
      <TabHeader title="Agent" body="Every agent you connect with an access token acts under this one identity, so its cards and comments are told apart from yours." />
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
        {save.isError ? <p className="text-[13px] text-danger">{save.error.message}</p> : null}
        <div>
          <Button type="submit" variant="primary" loading={save.isPending}>
            Save
          </Button>
          {save.isSuccess ? <span className="ml-3 text-[12.5px] text-ink-muted">Saved.</span> : null}
        </div>
      </form>
      <AccessTokensPanel agentName={draft.agentName} />
    </>
  );
}
