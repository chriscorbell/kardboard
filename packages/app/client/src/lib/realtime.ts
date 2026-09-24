import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { BoardEvent, BoardView, CardDetail } from "@kardboard/shared";
import { keys, upsertCardInBoard, upsertSessionInBoard } from "./api";
import { useAuth } from "./auth";
import { reconnectDelay } from "./backoff";
import { toast } from "./toast";

const EVENT_TYPES = ["card.upserted", "card.removed", "comment.upserted", "comment.removed", "session.updated", "board.updated", "board.deleted"] as const;

// Server-sent events keep the board query fresh without polling. Clerk mode cannot set headers on
// EventSource, so it falls back to a token query parameter over the same origin.
//
// That token lives about a minute, and EventSource's own retry reuses the URL it was given, so after
// a server restart (every deploy) it would come back with an expired token and give up on the 401.
// Every error therefore closes the stream and reconnects with a fresh token after a backoff. The
// stream carries no replay, so each `ready` refetches the board and any open card: that covers
// whatever changed while it was down, and between the first fetch and the first subscription.
export function useBoardEvents(slug: string | undefined) {
  const qc = useQueryClient();
  const { mode, getToken } = useAuth();
  // Read through a ref, so a new navigate function never tears the stream down and reconnects it.
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  useEffect(() => {
    if (!slug) return;
    let source: EventSource | null = null;
    let connecting = false;
    let stopped = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const handle = (e: MessageEvent<string>) => {
      const event = JSON.parse(e.data) as BoardEvent;
      switch (event.type) {
        case "card.upserted":
          upsertCardInBoard(qc, slug, event.card);
          qc.setQueryData<CardDetail>(keys.card(event.card.id), (d) => (d ? { ...d, card: event.card } : d));
          break;
        case "card.removed":
          qc.setQueryData<BoardView>(keys.board(slug), (v) => (v ? { ...v, cards: v.cards.filter((c) => c.id !== event.cardId) } : v));
          break;
        case "comment.upserted": {
          void qc.invalidateQueries({ queryKey: keys.card(event.comment.cardId) });
          // Someone the board has not named yet, such as a Member added since it loaded: re-read the
          // board so their Comment is signed with their name.
          const authorId = event.comment.authorKind === "user" ? event.comment.authorId : null;
          const view = qc.getQueryData<BoardView>(keys.board(slug));
          if (authorId && view && !view.people.some((p) => p.id === authorId)) void qc.invalidateQueries({ queryKey: keys.board(slug) });
          break;
        }
        // Dropped from the open sheet at once: a deleted Comment is often one nobody should keep reading.
        case "comment.removed":
          qc.setQueryData<CardDetail>(keys.card(event.cardId), (d) => (d ? { ...d, comments: d.comments.filter((c) => c.id !== event.commentId) } : d));
          break;
        case "session.updated":
          upsertSessionInBoard(qc, slug, event.session);
          if (event.session.cardId) void qc.invalidateQueries({ queryKey: keys.card(event.session.cardId) });
          break;
        case "board.updated":
          qc.setQueryData<BoardView>(keys.board(slug), (v) => (v ? { ...v, board: event.board } : v));
          break;
        // Nothing is left to show or reconnect to, so whoever is looking goes back to their boards.
        case "board.deleted":
          stopped = true;
          source?.close();
          qc.removeQueries({ queryKey: keys.board(slug) });
          void qc.invalidateQueries({ queryKey: keys.boards });
          toast("This board was deleted.");
          void navigateRef.current("/", { replace: true });
          break;
      }
    };

    const catchUp = () => {
      void qc.invalidateQueries({ queryKey: keys.board(slug) });
      void qc.invalidateQueries({ queryKey: ["card"] });
    };

    const retryLater = () => {
      if (stopped) return;
      clearTimeout(timer);
      timer = setTimeout(() => void connect(), reconnectDelay(attempt++));
    };

    const connect = async () => {
      if (stopped || source || connecting) return;
      connecting = true;
      let token: string | null = null;
      try {
        token = mode === "clerk" ? await getToken() : null;
      } catch {
        token = null;
      }
      connecting = false;
      if (stopped) return;
      if (mode === "clerk" && !token) return retryLater();
      const es = new EventSource(`/api/boards/${slug}/events${token ? `?token=${encodeURIComponent(token)}` : ""}`);
      source = es;
      es.addEventListener("ready", () => {
        attempt = 0;
        catchUp();
      });
      for (const type of EVENT_TYPES) es.addEventListener(type, handle as EventListener);
      es.onerror = () => {
        es.close();
        if (source === es) source = null;
        retryLater();
      };
    };

    // Coming back online or to the tab should not wait out a long backoff.
    const wake = () => {
      if (source || connecting || stopped || document.visibilityState !== "visible") return;
      clearTimeout(timer);
      void connect();
    };

    void connect();
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      source?.close();
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [slug, qc, mode, getToken]);
}
