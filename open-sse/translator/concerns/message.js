import { OPENAI_BLOCK } from "../schema/index.js";

// Collapse text-only OpenAI content-part arrays to the plain string form
// accepted by providers. Mixed text/media content must remain structured.
export function collapseTextParts(parts) {
  if (!Array.isArray(parts)) return parts;
  if (parts.length > 0 && parts.every((part) => part?.type === OPENAI_BLOCK.TEXT)) {
    return parts.map((part) => part.text || "").join("\n");
  }
  return parts;
}
