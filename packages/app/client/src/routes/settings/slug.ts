// The Board slug rules live in the shared package, since an agent creating a Board over MCP gets the
// same slug from a name as the settings dialog does.
export { slugDraft, slugify } from "@kardboard/shared";
