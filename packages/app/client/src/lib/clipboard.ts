// Puts text on the clipboard, or throws. kardboard is served over plain http, where a browser offers
// no `navigator.clipboard` outside localhost, so it falls back to the older copy command on a hidden
// field. That has to run inside the click that asked for it, so call this before awaiting anything.
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) return navigator.clipboard.writeText(text);
  const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const field = document.createElement("textarea");
  field.value = text;
  field.setAttribute("readonly", "");
  field.style.position = "fixed";
  field.style.opacity = "0";
  document.body.append(field);
  field.select();
  try {
    if (!document.execCommand("copy")) throw new Error("The browser refused to copy.");
  } finally {
    field.remove();
    previous?.focus();
  }
}
