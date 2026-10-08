import { useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { ArrowRight } from "lucide-react";
import { useCreateMe } from "../lib/api";
import { Button, Input } from "../components/ui";
import { Wordmark } from "../components/Wordmark";

// The first time kardboard is opened there is nobody to sign anything, and a name is all it needs.
export function FirstRunPage() {
  const reduce = useReducedMotion();
  const create = useCreateMe();
  const [name, setName] = useState("");
  const ready = name.trim().length > 0;
  return (
    <div className="flex min-h-dvh items-center justify-center p-6">
      <motion.form
        initial={reduce ? false : { opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
        className="flex w-full max-w-sm flex-col gap-6"
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) create.mutate({ name: name.trim() });
        }}
      >
        <Wordmark />
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">What should kardboard call you?</h1>
          <p className="mt-1.5 text-[13.5px] text-ink-muted">It signs your cards and comments. You can change it in Settings.</p>
        </div>
        <div className="flex flex-col gap-3">
          <Input autoFocus aria-label="Your name" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)} maxLength={60} autoComplete="name" disabled={create.isPending} />
          {create.isError ? (
            <p role="alert" className="text-[13px] text-danger">
              {create.error.message}
            </p>
          ) : null}
          <Button type="submit" variant="primary" disabled={!ready} loading={create.isPending} className="self-start">
            Continue
            <ArrowRight className="size-4" strokeWidth={1.75} aria-hidden="true" />
          </Button>
        </div>
      </motion.form>
    </div>
  );
}
