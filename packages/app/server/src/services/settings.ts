import { eq } from "drizzle-orm";
import { MAX_WALL_CLOCK_MINUTES, type Settings, type AgentProfile } from "@kardboard/shared";
import { db, schema } from "../db/index.js";

const DEFAULTS: Settings = {
  agentName: "Milo",
  agentAvatarUrl: "/brand/milo.png",
  globalMaxConcurrentSessions: 4,
  sessionWallClockMinutes: 45,
  // On by default: both Providers now keep their credential in the egress proxy, which is the
  // condition ADR 0002 put on entering the other one automatically.
  providerFallback: true,
};

// The cap arrived after this setting could be saved at up to 240 minutes. A stored value above it is
// read as the cap rather than rewritten, so the Agent tab shows what Sessions actually get and the
// next save stores it. Nothing below the cap is raised: tests store fractions of a minute.
export function wallClockMinutes(stored: string): number {
  const n = Number(stored);
  if (!Number.isFinite(n) || n <= 0) return DEFAULTS.sessionWallClockMinutes;
  return Math.min(n, MAX_WALL_CLOCK_MINUTES);
}

export async function getSettings(): Promise<Settings> {
  const rows = await db.select().from(schema.settings);
  const out: Settings = { ...DEFAULTS };
  for (const r of rows) {
    switch (r.key) {
      case "agentName":
        out.agentName = r.value;
        break;
      case "agentAvatarUrl":
        out.agentAvatarUrl = r.value || null;
        break;
      case "globalMaxConcurrentSessions":
        out.globalMaxConcurrentSessions = Number(r.value);
        break;
      case "sessionWallClockMinutes":
        out.sessionWallClockMinutes = wallClockMinutes(r.value);
        break;
      case "providerFallback":
        // Stored by `updateSettings` as String(boolean); anything else is an older or hand-edited row.
        out.providerFallback = r.value !== "false";
        break;
    }
  }
  return out;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    const str = value === null ? "" : String(value);
    await db
      .insert(schema.settings)
      .values({ key, value: str })
      .onConflictDoUpdate({ target: schema.settings.key, set: { value: str } });
  }
  return getSettings();
}

export async function getAgentProfile(): Promise<AgentProfile> {
  const s = await getSettings();
  return { name: s.agentName, avatarUrl: s.agentAvatarUrl };
}

export async function getSettingValue(key: string): Promise<string | null> {
  const row = await db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
  return row?.value ?? null;
}
