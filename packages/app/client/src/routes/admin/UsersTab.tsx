import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UserMinus, UserPlus } from "lucide-react";
import type { User } from "@kardboard/shared";
import { keys, request, useAdminUsers, useMe } from "../../lib/api";
import { Avatar, Button, Chip, ErrorState, Field, Input, Select, Skeleton } from "../../components/ui";
import { Dialog } from "../../components/Dialog";
import { Menu } from "../../components/Menu";
import { relativeTime } from "../../lib/format";
import { toast } from "../../lib/toast";
import { TabHeader } from "./AdminPage";

const STATUS_TONE = { invited: "info", active: "ok", revoked: "danger" } as const;

export function UsersTab() {
  const users = useAdminUsers();
  const me = useMe();
  const qc = useQueryClient();
  const [inviting, setInviting] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const invite = useMutation({
    mutationFn: () => request<User>("/admin/users", { method: "POST", body: JSON.stringify({ email, name, role }) }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: keys.adminUsers });
      setInviting(false);
      setEmail("");
      setName("");
      setRole("member");
    },
  });
  const setStatus = useMutation({
    mutationFn: ({ id, action }: { id: string; action: "revoke" | "reinstate" }) => request(`/admin/users/${id}/${action}`, { method: "POST" }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: keys.adminUsers }),
  });
  // The user stays set after closing, so the dialog keeps its words while it fades out.
  const [removing, setRemoving] = useState<User | null>(null);
  const [removeOpen, setRemoveOpen] = useState(false);
  const remove = useMutation({
    mutationFn: (u: User) => request(`/admin/users/${u.id}`, { method: "DELETE" }),
    onSuccess: (_data, u) => {
      void qc.invalidateQueries({ queryKey: keys.adminUsers });
      void qc.invalidateQueries({ queryKey: keys.adminBoards });
      toast(`Removed ${u.name}.`);
      setRemoveOpen(false);
    },
  });
  // Resending changes nothing visible about the user, so the row says so for a moment instead.
  const [resentTo, setResentTo] = useState<string | null>(null);
  const resend = useMutation({
    mutationFn: (id: string) => request(`/admin/users/${id}/resend-invitation`, { method: "POST" }),
    onSuccess: (_data, id) => {
      setResentTo(id);
      setTimeout(() => setResentTo((current) => (current === id ? null : current)), 4000);
    },
  });

  return (
    <>
      <TabHeader
        title="Users"
        body="Only invited email addresses can sign in. Membership on each board is set from the Boards tab."
        action={
          <Button variant="primary" icon={<UserPlus className="size-4" strokeWidth={1.75} />} onClick={() => setInviting(true)}>
            Invite
          </Button>
        }
      />
      {users.isPending ? (
        <Skeleton className="h-40" />
      ) : !users.data ? (
        <ErrorState title="Could not load users." error={users.error} onRetry={() => void users.refetch()} retrying={users.isFetching} />
      ) : (
        <ul className="divide-y divide-line rounded-card border border-line bg-surface">
          {users.data.map((u) => (
            <li key={u.id} className="flex items-center gap-3 px-4 py-3">
              <Avatar name={u.name} url={u.avatarUrl} size={30} />
              {/* On a phone the chips sit under the name instead of squeezing it to nothing. */}
              <div className="min-w-0 flex-1 sm:flex sm:items-center sm:gap-3">
                <div className="min-w-0 sm:flex-1">
                  <p className="truncate text-[13.5px] font-medium text-ink">
                    {u.name} <span className="font-mono text-[11.5px] font-normal text-ink-faint">@{u.handle}</span>
                  </p>
                  <p className="truncate text-[12.5px] text-ink-muted">{u.email}</p>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5 sm:mt-0 sm:gap-3">
                  {u.role === "admin" ? <Chip tone="accent">Admin</Chip> : null}
                  {resentTo === u.id ? <Chip tone="ok">invitation sent</Chip> : <Chip tone={STATUS_TONE[u.status]}>{u.status}</Chip>}
                  <span className="hidden w-16 text-right font-mono text-[11px] text-ink-faint sm:inline">{relativeTime(u.createdAt)}</span>
                </div>
              </div>
              <Menu
                align="right"
                trigger={<Button size="sm" variant="ghost">Manage</Button>}
                items={
                  u.status === "revoked"
                    ? [
                        { label: "Reinstate", onSelect: () => setStatus.mutate({ id: u.id, action: "reinstate" }) },
                        {
                          label: "Remove user",
                          danger: true,
                          disabled: u.id === me.data?.user.id,
                          onSelect: () => {
                            remove.reset();
                            setRemoving(u);
                            setRemoveOpen(true);
                          },
                        },
                      ]
                    : [
                        ...(u.status === "invited" ? [{ label: "Resend invitation", onSelect: () => resend.mutate(u.id) }] : []),
                        { label: "Revoke access", danger: true, disabled: u.id === me.data?.user.id, onSelect: () => setStatus.mutate({ id: u.id, action: "revoke" }) },
                      ]
                }
              />
            </li>
          ))}
        </ul>
      )}
      <Dialog open={removeOpen} onClose={() => setRemoveOpen(false)} title="Remove user">
        {removing ? (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2 text-[13.5px] leading-relaxed text-ink-muted">
              <p>
                <span className="font-medium text-ink">{removing.name}</span> leaves this list for good. Their email address, sign-in, and board access are deleted, along with their
                notifications.
              </p>
              <p>Cards, comments, and approvals they wrote stay, under their name. You can invite {removing.email} again later as a new account.</p>
            </div>
            {remove.isError ? <p className="text-[13px] text-danger">{remove.error.message}</p> : null}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setRemoveOpen(false)}>
                Cancel
              </Button>
              <Button variant="danger" icon={<UserMinus className="size-4" strokeWidth={1.75} />} loading={remove.isPending} onClick={() => remove.mutate(removing)}>
                Remove user
              </Button>
            </div>
          </div>
        ) : null}
      </Dialog>
      <Dialog open={inviting} onClose={() => setInviting(false)} title="Invite a user">
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            invite.mutate();
          }}
        >
          <Field label="Email" hint="The invitation goes here, and they sign in with it. The @handle is derived from it.">
            <Input type="email" autoFocus required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@company.com" />
          </Field>
          <Field label="Name">
            <Input required value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
          </Field>
          <Field label="Role">
            <Select value={role} onChange={(e) => setRole(e.target.value as "member" | "admin")}>
              <option value="member">Member (per-board access)</option>
              <option value="admin">Admin (everything)</option>
            </Select>
          </Field>
          {invite.isError ? <p className="text-[13px] text-danger">{invite.error.message}</p> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={() => setInviting(false)}>
              Cancel
            </Button>
            <Button type="submit" variant="primary" loading={invite.isPending}>
              Send invitation
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
