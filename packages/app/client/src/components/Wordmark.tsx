import { Link } from "react-router";

// `compact` keeps only the mark on a phone, where the header needs the room for the board's name.
export function Wordmark({ to = "/", compact = false }: { to?: string; compact?: boolean }) {
  return (
    <Link to={to} aria-label="kardboard" className="inline-flex shrink-0 items-center gap-2 rounded-control text-ink no-underline">
      <svg width="20" height="20" viewBox="0 0 32 32" aria-hidden="true">
        <rect x="3" y="3" width="26" height="26" rx="6" fill="#d9a05b" />
        <rect x="9" y="9" width="6" height="14" rx="1.5" fill="#121110" />
        <rect x="17" y="9" width="6" height="8" rx="1.5" fill="#121110" />
      </svg>
      <span className={compact ? "hidden text-[15px] font-semibold tracking-tight sm:inline" : "text-[15px] font-semibold tracking-tight"}>kardboard</span>
    </Link>
  );
}
