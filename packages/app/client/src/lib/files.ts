// Picking files to attach, kept apart from the components that take them so the rules can be tested:
// what is too large, what a pasted screenshot is called, and what to tell someone about it.

// The server refuses anything larger (routes/api.ts).
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

export function partitionBySize<F extends { size: number }>(files: readonly F[], limit = MAX_ATTACHMENT_BYTES): { accepted: F[]; tooLarge: F[] } {
  const accepted: F[] = [];
  const tooLarge: F[] = [];
  for (const f of files) (f.size > limit ? tooLarge : accepted).push(f);
  return { accepted, tooLarge };
}

// Said once, for everything left out of one pick, paste, or drop.
export function tooLargeMessage(names: readonly string[]): string | null {
  if (names.length === 0) return null;
  if (names.length === 1) return `${names[0]} is over the 25 MB limit, so it was not added.`;
  return `${names.length} files are over the 25 MB limit, so they were not added: ${names.join(", ")}.`;
}

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/avif": "avif",
};

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

// A pasted screenshot arrives as "image.png" every time, so three of them on one comment would be
// indistinguishable. Such a file is renamed for when it was pasted; a file with a real name keeps it.
export function pastedFileName(file: { name: string; type: string }, at: Date, index = 0): string {
  const generic = !file.name || /^image\.(png|jpe?g|gif|webp)$/i.test(file.name);
  if (!generic) return file.name;
  const ext = EXTENSIONS[file.type] ?? (file.name.split(".").pop() || "bin");
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}.${pad(at.getMinutes())}.${pad(at.getSeconds())}`;
  return `Pasted ${stamp}${index > 0 ? ` (${index + 1})` : ""}.${ext}`;
}

// Whether a clipboard paste is a file to attach rather than text to insert. Copying an image from a
// document can carry both; the text wins then, since that is what a person pasting into a text box
// usually meant.
export function pasteIsFiles(clipboard: { fileCount: number; text: string }): boolean {
  return clipboard.fileCount > 0 && clipboard.text.trim() === "";
}
