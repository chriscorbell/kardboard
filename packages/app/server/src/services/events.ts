import type { ActorKind } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { newId } from "../ids.js";

export interface Actor {
  kind: ActorKind;
  id: string | null;
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
    payload: input.payload ?? {},
  });
}
