import { useId } from "react";
import { Check, Loader2 } from "lucide-react";
import { EMAIL_PREFERENCES, type EmailPreference, type Me } from "@kardboard/shared";
import { useUpdateMe } from "../lib/api";
import { Dialog } from "./Dialog";
import { Button, cx } from "./ui";

const OPTIONS: Record<EmailPreference, { label: string; detail: string }> = {
  all: { label: "All", detail: "Mentions, questions, reviews, failed work, and your cards reaching Done." },
  important: { label: "Important only", detail: "Mentions, questions, reviews, and failed work." },
  off: { label: "Off", detail: "No email. The bell still shows everything." },
};

// How much of what the bell records also arrives by email. A choice saves as it is made.
export function EmailPreferences({ me, open, onClose }: { me: Me; open: boolean; onClose: () => void }) {
  const update = useUpdateMe();
  const name = useId();
  const pending = update.isPending ? update.variables?.emailPreference : undefined;
  return (
    <Dialog open={open} onClose={onClose} title="Email notifications" width={440}>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-3 text-[13px] text-ink-muted">Everything shows under the bell. Choose what also comes to {me.user.email}.</legend>
        {EMAIL_PREFERENCES.map((p) => {
          const selected = (pending ?? me.emailPreference) === p;
          return (
            <label
              key={p}
              className={cx(
                "flex cursor-pointer items-start gap-3 rounded-card border px-3.5 py-3 transition-colors duration-150 has-[:focus-visible]:border-accent",
                selected ? "border-accent/40 bg-accent-soft" : "border-line hover:border-line-strong",
              )}
            >
              <input
                type="radio"
                name={name}
                value={p}
                checked={selected}
                onChange={() => update.mutate({ emailPreference: p })}
                className="sr-only"
              />
              <span className={cx("mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full border", selected ? "border-accent bg-accent text-accent-ink" : "border-line-strong")} aria-hidden="true">
                {pending === p ? <Loader2 className="size-3 animate-spin" strokeWidth={2} /> : selected ? <Check className="size-3" strokeWidth={2.5} /> : null}
              </span>
              <span className="min-w-0">
                <span className="block text-[13.5px] font-medium text-ink">{OPTIONS[p].label}</span>
                <span className="mt-0.5 block text-[12.5px] leading-snug text-ink-muted">{OPTIONS[p].detail}</span>
              </span>
            </label>
          );
        })}
      </fieldset>
      {update.isError ? (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          That was not saved. {update.error.message}
        </p>
      ) : null}
      <div className="mt-5 flex justify-end">
        <Button variant="secondary" onClick={onClose}>
          Done
        </Button>
      </div>
    </Dialog>
  );
}
