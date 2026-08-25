import { cleanJSONSchemaForAntigravity } from "../translator/formats/gemini.js";
import { AntigravityError, AntigravityErrorCode } from "./errors.js";

const UNSUPPORTED_SCHEMA_KEYS = new Set(["$ref", "allOf", "anyOf", "oneOf", "not"]);

export function sanitizeAntigravityFunctionName(name, used = new Set()) {
  let value = String(name || "_unknown").replace(/[^a-zA-Z0-9_.:\-]/g, "_");
  if (!/^[a-zA-Z_]/.test(value)) value = `_${value}`;
  value = value.slice(0, 64);
  const base = value;
  let index = 2;
  while (used.has(value)) value = `${base.slice(0, 64 - String(index).length - 1)}_${index++}`;
  used.add(value);
  return value;
}

function schemaError() {
  return new AntigravityError(
    AntigravityErrorCode.BAD_TOOL_SCHEMA,
    "Antigravity tool schema contains unsupported recursive or composite JSON Schema constructs",
    { status: 400, retryable: false },
  );
}

/** Validates only constructs Antigravity cannot safely receive after cleaning. */
export function validateAntigravityToolSchema(schema, seen = new WeakSet()) {
  if (schema == null) return;
  if (typeof schema !== "object" || Array.isArray(schema)) throw schemaError();
  if (seen.has(schema)) throw schemaError();
  seen.add(schema);

  for (const key of UNSUPPORTED_SCHEMA_KEYS) {
    if (Object.hasOwn(schema, key)) throw schemaError();
  }
  if (schema.properties != null) {
    if (typeof schema.properties !== "object" || Array.isArray(schema.properties)) throw schemaError();
    for (const child of Object.values(schema.properties)) validateAntigravityToolSchema(child, seen);
  }
  if (schema.items != null) {
    if (Array.isArray(schema.items)) {
      for (const child of schema.items) validateAntigravityToolSchema(child, seen);
    } else {
      validateAntigravityToolSchema(schema.items, seen);
    }
  }
  if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
    validateAntigravityToolSchema(schema.additionalProperties, seen);
  }
  seen.delete(schema);
}

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
      validateAntigravityToolSchema(parameters);
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
