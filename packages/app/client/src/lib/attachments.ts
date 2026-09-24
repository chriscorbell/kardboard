import { useEffect, useRef, useState, type RefObject } from "react";
import { requestBlob } from "./api";

// Attachments are served only to the bearer token, never to a cookie, so a plain <img src> or
// <a href> to /api/attachments is refused in production. They are fetched like any API call and
// shown from an object URL, which is released when the view goes away.

export type AttachmentLoad = { status: "idle" } | { status: "loading" } | { status: "ready"; url: string } | { status: "error"; error: unknown };

export function useAttachmentUrl(id: string, enabled: boolean): AttachmentLoad & { retry: () => void } {
  const [load, setLoad] = useState<AttachmentLoad>({ status: "idle" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let url: string | null = null;
    setLoad({ status: "loading" });
    requestBlob(`/attachments/${id}`).then(
      (blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setLoad({ status: "ready", url });
      },
      (error: unknown) => {
        if (!cancelled) setLoad({ status: "error", error });
      },
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [id, enabled, attempt]);
  return { ...load, retry: () => setAttempt((n) => n + 1) };
}

// True once the element has come near the viewport, so a long thread does not fetch every image up front.
export function useNearViewport(ref: RefObject<Element | null>): boolean {
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (near || !el) return;
    if (typeof IntersectionObserver === "undefined") {
      setNear(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) setNear(true);
      },
      { rootMargin: "240px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, near]);
  return near;
}

export function useAttachmentDownload(id: string, filename: string) {
  const [state, setState] = useState<{ busy: boolean; error: unknown }>({ busy: false, error: null });
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const download = async () => {
    if (state.busy) return;
    setState({ busy: true, error: null });
    try {
      const url = URL.createObjectURL(await requestBlob(`/attachments/${id}`));
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.append(a);
      a.click();
      a.remove();
      // The click hands the URL to the download manager, which reads it after this returns.
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
      if (mounted.current) setState({ busy: false, error: null });
    } catch (error) {
      if (mounted.current) setState({ busy: false, error });
    }
  };
  return { ...state, download };
}
