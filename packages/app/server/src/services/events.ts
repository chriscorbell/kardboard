import type { ActorKind } from "@kardboard/shared";
import { db, schema } from "../db/index.js";
import { newId } from "../ids.js";

export interface Actor {
  kind: ActorKind;
  id: string | null;
  // The Access token an agent outside kardboard acted through as the Agent. Which token is on the
  // record, so what one did can be told apart after it is revoked.
  accessTokenId?: string;
}

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
    payload: { ...(input.actor.accessTokenId ? { accessTokenId: input.actor.accessTokenId } : {}), ...(input.payload ?? {}) },
  });
}
