import type { AgentProfile, Person } from "@kardboard/shared";

// Who the composer's @ list offers, kept out of the component so it can be tested.

export type MentionCandidate = { handle: string; name: string; avatarUrl: string | null; agent: boolean };

/**
 * The Agent first, then the Board's people, whose handle starts with what was typed or whose name
 * contains it. The Agent's handle is its name as written, "Milo" rather than "milo": Mentions match
 * without regard to case, so either one reaches it, and this is how a posted Comment shows it.
 */
export function mentionCandidates(agent: Pick<AgentProfile, "name" | "avatarUrl">, members: Pick<Person, "handle" | "name" | "avatarUrl">[], query: string): MentionCandidate[] {
  const all: MentionCandidate[] = [
    { handle: agent.name, name: agent.name, avatarUrl: agent.avatarUrl, agent: true },
    ...members.map((m) => ({ handle: m.handle, name: m.name, avatarUrl: m.avatarUrl, agent: false })),
  ];
  const q = query.toLowerCase();
  return all.filter((c) => c.handle.toLowerCase().startsWith(q) || c.name.toLowerCase().includes(q)).slice(0, 6);
}
