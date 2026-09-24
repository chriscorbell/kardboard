import { forwardRef, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { AlertCircle, Loader2 } from "lucide-react";
import { initials } from "../lib/format";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  loading?: boolean;
  icon?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = "secondary", size = "md", loading, icon, className, children, disabled, ...rest },
  ref,
) {
  const base =
    "inline-flex items-center justify-center gap-1.5 rounded-control font-medium whitespace-nowrap select-none transition-[background-color,border-color,color,transform] duration-150 ease-out-expo active:translate-y-px disabled:opacity-50 disabled:pointer-events-none";
  const sizes = size === "sm" ? "h-7 px-2.5 text-[13px]" : "h-9 px-3.5 text-sm";
  const variants = {
    primary: "bg-accent text-accent-ink hover:bg-[#e2ad6c]",
    secondary: "bg-raised border border-line-strong text-ink hover:bg-overlay hover:border-[#4a463f]",
    ghost: "text-ink-muted hover:text-ink hover:bg-raised",
    danger: "bg-transparent border border-line-strong text-danger hover:bg-[rgba(217,130,116,0.1)] hover:border-danger",
  }[variant];
  return (
    <button ref={ref} className={cx(base, sizes, variants, className)} disabled={disabled || loading} {...rest}>
      {loading ? <Loader2 className="size-4 animate-spin" strokeWidth={1.75} /> : icon}
      {children}
    </button>
  );
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { label: string }>(function IconButton(
  { label, className, children, ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      aria-label={label}
      title={label}
      className={cx(
        "inline-flex size-8 items-center justify-center rounded-control text-ink-muted transition-colors duration-150 hover:bg-raised hover:text-ink active:translate-y-px disabled:opacity-40 disabled:pointer-events-none",
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
});

export function Avatar({ name, url, size = 24, tone = "neutral", className }: { name: string; url?: string | null; size?: number; tone?: "neutral" | "agent"; className?: string }) {
  const style = { width: size, height: size, fontSize: Math.max(9, Math.round(size * 0.4)) };
  if (url) return <img src={url} alt={name} title={name} className={cx("rounded-full object-cover", className)} style={style} />;
  return (
    <span
      title={name}
      className={cx(
        "inline-flex shrink-0 items-center justify-center rounded-full font-semibold tracking-wide",
        tone === "agent" ? "bg-accent-soft text-accent ring-1 ring-inset ring-accent/40" : "bg-overlay text-ink-muted",
        className,
      )}
      style={style}
    >
      {initials(name)}
    </span>
  );
}

export function Chip({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "accent" | "ok" | "warn" | "danger" | "info"; className?: string }) {
  const tones = {
    neutral: "bg-raised text-ink-muted border-line",
    accent: "bg-accent-soft text-accent border-accent/30",
    ok: "bg-[rgba(143,187,135,0.12)] text-ok border-ok/30",
    warn: "bg-[rgba(217,178,108,0.12)] text-warn border-warn/30",
    danger: "bg-[rgba(217,130,116,0.12)] text-danger border-danger/30",
    info: "bg-[rgba(134,171,201,0.12)] text-info border-info/30",
  }[tone];
  return <span className={cx("inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[12px] font-medium leading-none", tones, className)}>{children}</span>;
}

export function Field({ label, hint, error, children, className }: { label: ReactNode; hint?: string; error?: string | null; children: ReactNode; className?: string }) {
  return (
    <label className={cx("flex flex-col gap-1.5", className)}>
      <span className="text-[13px] font-medium text-ink-muted">{label}</span>
      {children}
      {error ? <span className="text-[12px] text-danger">{error}</span> : hint ? <span className="text-[12px] text-ink-faint">{hint}</span> : null}
    </label>
  );
}

const inputBase =
  "w-full rounded-control border border-line-strong bg-surface px-3 text-sm text-ink placeholder:text-ink-faint transition-colors duration-150 hover:border-[#4a463f] focus:border-accent focus:outline-none disabled:opacity-50";

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...rest }, ref) {
  return <input ref={ref} className={cx(inputBase, "h-9", className)} {...rest} />;
});

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...rest }, ref) {
  return <textarea ref={ref} className={cx(inputBase, "min-h-24 resize-y py-2 leading-relaxed", className)} {...rest} />;
});

export const Select = forwardRef<HTMLSelectElement, SelectHTMLAttributes<HTMLSelectElement>>(function Select({ className, children, ...rest }, ref) {
  return (
    <select ref={ref} className={cx(inputBase, "h-9 appearance-none bg-[url('data:image/svg+xml,%3Csvg xmlns=%27http://www.w3.org/2000/svg%27 width=%2716%27 height=%2716%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%23a69f93%27 stroke-width=%271.75%27 stroke-linecap=%27round%27 stroke-linejoin=%27round%27%3E%3Cpath d=%27m6 9 6 6 6-6%27/%3E%3C/svg%3E')] bg-[length:16px] bg-[right_8px_center] bg-no-repeat pr-8", className)} {...rest}>
      {children}
    </select>
  );
});

export function EmptyState({ title, body, action }: { title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-panel border border-dashed border-line-strong px-6 py-12 text-center">
      <p className="text-sm font-medium text-ink">{title}</p>
      {body ? <p className="max-w-sm text-[13px] text-ink-muted">{body}</p> : null}
      {action ? <div className="mt-2">{action}</div> : null}
    </div>
  );
}

// A load that failed: what could not be shown, why, and a retry. `compact` sits inline in a section.
export function ErrorState({ title, error, onRetry, retrying, compact, className }: { title: string; error?: unknown; onRetry?: () => void; retrying?: boolean; compact?: boolean; className?: string }) {
  const detail = error instanceof Error && error.message ? error.message : null;
  if (compact) {
    return (
      <div role="alert" className={cx("flex items-start gap-2 text-[13px]", className)}>
        <AlertCircle className="mt-0.5 size-4 shrink-0 text-danger" strokeWidth={1.75} />
        <p className="min-w-0 flex-1 text-ink-muted">
          <span className="text-ink">{title}</span>
          {detail ? ` ${detail}` : null}
        </p>
        {onRetry ? (
          <Button size="sm" variant="ghost" className="-my-1 shrink-0" loading={retrying} onClick={onRetry}>
            Try again
          </Button>
        ) : null}
      </div>
    );
  }
  return (
    <div role="alert" className={cx("flex flex-col items-center justify-center gap-2 rounded-panel border border-line px-6 py-12 text-center", className)}>
      <AlertCircle className="size-5 text-danger" strokeWidth={1.75} />
      <p className="text-sm font-medium text-ink">{title}</p>
      {detail ? <p className="max-w-sm text-[13px] text-ink-muted">{detail}</p> : null}
      {onRetry ? (
        <Button size="sm" className="mt-2" loading={retrying} onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("animate-pulse rounded-control bg-raised", className)} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded border border-line-strong bg-surface px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">{children}</kbd>;
}
