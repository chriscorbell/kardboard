import { useRef, useState, type ClipboardEvent, type DragEvent } from "react";
import { pastedFileName, pasteIsFiles } from "./files";

function carriesFiles(e: DragEvent): boolean {
  return Array.from(e.dataTransfer?.types ?? []).includes("Files");
}

// A surface files can be dropped on. `over` is true while a file is dragged across it, so the
// surface can say what a drop will do. Text and cards being dragged are left alone.
export function useFileDrop(onFiles: (files: File[]) => void, enabled = true) {
  const [over, setOver] = useState(false);
  // dragenter and dragleave fire for every child crossed, so only the outermost pair counts.
  const depth = useRef(0);
  const handlers = {
    onDragEnter: (e: DragEvent) => {
      if (!enabled || !carriesFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setOver(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!enabled || !carriesFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    onDragLeave: (e: DragEvent) => {
      if (!enabled || !carriesFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setOver(false);
    },
    onDrop: (e: DragEvent) => {
      if (!enabled || !carriesFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) onFiles(files);
    },
  };
  return { over, handlers };
}

// The files a paste carries, renamed where the browser gave them no name of their own, or null when
// the paste is text and should go into the field as usual.
export function filesFromPaste(e: ClipboardEvent): File[] | null {
  const files = Array.from(e.clipboardData?.files ?? []);
  if (!pasteIsFiles({ fileCount: files.length, text: e.clipboardData?.getData("text/plain") ?? "" })) return null;
  const at = new Date();
  return files.map((f, i) => {
    const name = pastedFileName(f, at, i);
    return name === f.name ? f : new File([f], name, { type: f.type, lastModified: f.lastModified });
  });
}

// A file dropped anywhere that is not a drop surface would otherwise make the browser open it in
// place of the app, taking a half-written Card or Comment with it. Installed once for the page.
export function guardStrayFileDrops(): () => void {
  const hasFiles = (e: globalThis.DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes("Files");
  const onDragOver = (e: globalThis.DragEvent) => {
    if (!hasFiles(e) || e.defaultPrevented) return;
    e.preventDefault();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "none";
  };
  const onDrop = (e: globalThis.DragEvent) => {
    if (hasFiles(e) && !e.defaultPrevented) e.preventDefault();
  };
  window.addEventListener("dragover", onDragOver);
  window.addEventListener("drop", onDrop);
  return () => {
    window.removeEventListener("dragover", onDragOver);
    window.removeEventListener("drop", onDrop);
  };
}
