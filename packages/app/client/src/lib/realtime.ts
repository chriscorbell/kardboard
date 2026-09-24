import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { BoardEvent, BoardView, CardDetail } from "@kardboard/shared";
import { keys, upsertCardInBoard, upsertSessionInBoard } from "./api";
import { useAuth } from "./auth";

// Server-sent events keep the board query fresh without polling. Clerk mode cannot set headers on
// EventSource, so it falls back to a token query parameter over the same origin.
export function useBoardEvents(slug: string | undefined) {
  const qc = useQueryClient();
  const { mode, getToken } = useAuth();
  useEffect(() => {
    if (!slug) return;
    let es: EventSource | null = null;
    let cancelled = false;
    void (async () => {
      const token = mode === "clerk" ? await getToken() : null;
      if (cancelled) return;
      const url = `/api/boards/${slug}/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
      es = new EventSource(url);
      const handle = (e: MessageEvent) => {
        const event = JSON.parse(e.data) as BoardEvent;
        switch (event.type) {
          case "card.upserted":
            upsertCardInBoard(qc, slug, event.card);
            qc.setQueryData<CardDetail>(keys.card(event.card.id), (d) => (d ? { ...d, card: event.card } : d));
            break;
          case "card.removed":
            qc.setQueryData<BoardView>(keys.board(slug), (v) => (v ? { ...v, cards: v.cards.filter((c) => c.id !== event.cardId) } : v));
            break;
          case "comment.upserted":
            void qc.invalidateQueries({ queryKey: keys.card(event.comment.cardId) });
            break;
          case "session.updated":
            upsertSessionInBoard(qc, slug, event.session);
            if (event.session.cardId) void qc.invalidateQueries({ queryKey: keys.card(event.session.cardId) });
            break;
          case "board.updated":
            qc.setQueryData<BoardView>(keys.board(slug), (v) => (v ? { ...v, board: event.board } : v));
            break;
        }
      };
      for (const type of ["card.upserted", "card.removed", "comment.upserted", "session.updated", "board.updated"]) {
        es.addEventListener(type, handle as EventListener);
      }
    })();
    return () => {
      cancelled = true;
      es?.close();
    };
  }, [slug, qc, mode, getToken]);
}
