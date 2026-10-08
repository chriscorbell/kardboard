import { eq } from "drizzle-orm";
import type { Settings, AgentProfile } from "@kardboard/shared";
import { db, schema } from "../db/index.js";

const DEFAULTS: Settings = {
  agentName: "Agent",
  agentAvatarUrl: "/brand/agent.png",
};

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

// Small operational state that has to outlive a restart, such as the last backup attempt or when an
// alert was last sent, kept in the same table under a namespaced key. `getSettings` ignores keys it
// does not know and the settings route accepts only its own, so these cannot collide.
export async function setSettingValue(key: string, value: string): Promise<void> {
  await db.insert(schema.settings).values({ key, value }).onConflictDoUpdate({ target: schema.settings.key, set: { value } });
}
