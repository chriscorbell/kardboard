import { useEffect, useState } from "react";
import { useMe, useUpdateMe } from "../../lib/api";
import { Avatar, Button, Field, Input, Skeleton } from "../../components/ui";
import { TabHeader } from "./SettingsPage";

export function YouTab() {
  const me = useMe();
  const update = useUpdateMe();
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    if (me.data?.user && name === null) setName(me.data.user.name);
  }, [me.data?.user, name]);
  if (name === null) return <Skeleton className="h-32" />;
  const changed = name.trim() !== me.data?.user?.name && name.trim().length > 0;
  return (
    <>
      <TabHeader title="You" body="The name your cards and comments carry, set apart from the Agent's." />
      <form
        className="flex max-w-lg flex-col gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed) update.mutate({ name: name.trim() }, { onSuccess: (m) => setName(m.user?.name ?? name) });
        }}
      >
        <div className="flex items-center gap-4">
          <Avatar name={name.trim() || "?"} size={48} />
          <Field label="Name" className="flex-1">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="name" />
          </Field>
        </div>
        {update.isError ? <p className="text-[13px] text-danger">{update.error.message}</p> : null}
        <div>
          <Button type="submit" variant="primary" disabled={!changed} loading={update.isPending}>
            Save
          </Button>
          {update.isSuccess && !changed ? <span className="ml-3 text-[12.5px] text-ink-muted">Saved.</span> : null}
        </div>
      </form>
    </>
  );
}
