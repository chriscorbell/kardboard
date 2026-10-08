import { useEffect, useRef } from "react";
import { useNavigate } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { BoardEvent, BoardView, CardDetail } from "@kardboard/shared";
import { keys, upsertCardInBoard } from "./api";
import { reconnectDelay } from "./backoff";
import { toast } from "./toast";

const EVENT_TYPES = ["card.upserted", "card.removed", "comment.upserted", "comment.removed", "board.updated", "board.deleted"] as const;

// Server-sent events keep the board query fresh without polling. Every error closes the stream and
// reconnects after a backoff, rather than leaving EventSource's own retry to give up after a server
// restart (every deploy). The stream carries no replay, so each `ready` refetches the board and any
// open card: that covers whatever changed while it was down, and between the first fetch and the
// first subscription.
export function useBoardEvents(slug: string | undefined) {
  const qc = useQueryClient();
  // Read through a ref, so a new navigate function never tears the stream down and reconnects it.
  const navigate = useNavigate();
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  useEffect(() => {
    if (!slug) return;
    let source: EventSource | null = null;
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
          // Someone with the Card open reads it again and finds it gone, rather than keep a copy.
          void qc.invalidateQueries({ queryKey: keys.card(event.cardId) });
          break;
        case "comment.upserted":
          void qc.invalidateQueries({ queryKey: keys.card(event.comment.cardId) });
          break;
        // Dropped from the open sheet at once: a deleted Comment is often one nobody should keep reading.
        case "comment.removed":
          qc.setQueryData<CardDetail>(keys.card(event.cardId), (d) => (d ? { ...d, comments: d.comments.filter((c) => c.id !== event.commentId) } : d));
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
      timer = setTimeout(connect, reconnectDelay(attempt++));
    };

    const connect = () => {
      if (stopped || source) return;
      const es = new EventSource(`/api/boards/${slug}/events`);
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
      if (source || stopped || document.visibilityState !== "visible") return;
      clearTimeout(timer);
      connect();
    };

    connect();
    window.addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      stopped = true;
      clearTimeout(timer);
      source?.close();
      window.removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [slug, qc]);
}
