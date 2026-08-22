import { cleanJSONSchemaForAntigravity } from "../translator/formats/gemini.js";
export function sanitizeAntigravityFunctionName(name, used = new Set()) { let value = String(name || "_unknown").replace(/[^a-zA-Z0-9_.:\-]/g, "_"); if (!/^[a-zA-Z_]/.test(value)) value = `_${value}`; value = value.slice(0, 64); const base = value; let i = 2; while (used.has(value)) value = `${base.slice(0, 64 - String(i).length - 1)}_${i++}`; used.add(value); return value; }
export function normalizeAntigravityTools(tools) {
  const used = new Set();
  const declarations = [];
  const seenSourceNames = new Set();
  for (const group of Array.isArray(tools) ? tools : []) {
    for (const fn of group?.functionDeclarations || []) {
      if (!fn || typeof fn !== "object") continue;
      const rawName = String(fn.name || "_unknown");
      const baseName = sanitizeAntigravityFunctionName(rawName);
      if (seenSourceNames.has(rawName) || used.has(baseName)) continue;
      seenSourceNames.add(rawName);
      const name = sanitizeAntigravityFunctionName(rawName, used);
      const parameters = fn.parameters || fn.parametersJsonSchema || { type: "object", properties: {} };
      const declaration = {
        ...fn,
        name,
        parameters: cleanJSONSchemaForAntigravity(structuredClone(parameters)),
      };
      delete declaration.parametersJsonSchema;
      delete declaration._sourceName;
      declarations.push(declaration);
    }
  }
  return declarations.length ? [{ functionDeclarations: declarations }] : [];
}
