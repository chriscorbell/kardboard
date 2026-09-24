// How long to wait before reconnecting after the `attempt`th failure in a row: 1 s, 2 s, 4 s, up to
// 30 s, each cut by up to a fifth at random so a deploy does not bring every open tab back at once.
export function reconnectDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(30_000, 1_000 * 2 ** Math.max(0, attempt));
  return Math.round(base * (0.8 + 0.2 * random()));
}
