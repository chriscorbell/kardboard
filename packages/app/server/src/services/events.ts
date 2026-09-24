import type { ActorKind } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { newId } from "../ids.js";

export interface Actor {
  kind: ActorKind;
  id: string | null;
  // The Session acting as the Agent. Every Session shares the Agent's identity, so this is what
  // tells them apart on the record: which Session created a Card, say, and may therefore edit it.
  sessionId?: string;
}

export const SYSTEM_ACTOR: Actor = { kind: "system", id: null };

export async function recordEvent(input: {
  boardId: string;
  cardId?: string | null;
  actor: Actor;
  type: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(schema.events).values({
    id: newId(),
    boardId: input.boardId,
    cardId: input.cardId ?? null,
    actorKind: input.actor.kind,
    actorId: input.actor.id,
    type: input.type,
    // A payload that names a Session of its own keeps it.
    payload: { ...(input.actor.sessionId ? { sessionId: input.actor.sessionId } : {}), ...(input.payload ?? {}) },
  });
}
