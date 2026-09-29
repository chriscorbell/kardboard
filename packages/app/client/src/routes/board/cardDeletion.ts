import type { Card } from "@kardboard/shared";

// Who may delete a Card, as the server decides it: the Admin any Card, a Member one they created.
// The Agent's Cards are the Admin's to delete, as its Comments are.
export function canDeleteCard(card: Pick<Card, "creatorKind" | "creatorId">, viewer: { id: string | null; isAdmin: boolean }): boolean {
  return viewer.isAdmin || (card.creatorKind === "user" && viewer.id !== null && card.creatorId === viewer.id);
}
