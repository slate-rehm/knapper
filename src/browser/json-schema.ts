/**
 * Best-effort JSON Schema → Zod raw shape for proxied @playwright/mcp tools.
 *
 * The MCP SDK only accepts Zod at registration time; upstream exposes JSON Schema.
 */

import { z } from "zod";

type JsonProp = {
  type?: string | string[];
  description?: string;
  enum?: string[];
  items?: JsonProp;
  default?: unknown;
};

function fieldFromProp(prop: JsonProp): z.ZodTypeAny {
  const types = Array.isArray(prop.type) ? prop.type : prop.type ? [prop.type] : [];
  let field: z.ZodTypeAny;

  if (prop.enum && prop.enum.length > 0) {
    field = z.enum(prop.enum as [string, ...string[]]);
  } else if (types.includes("boolean")) {
    field = z.boolean();
  } else if (types.includes("number") || types.includes("integer")) {
    field = z.number();
  } else if (types.includes("array")) {
    const item = prop.items ? fieldFromProp(prop.items) : z.unknown();
    field = z.array(item);
  } else if (types.includes("object")) {
    field = z.record(z.string(), z.unknown());
  } else {
    field = z.string();
  }

  if (prop.description) field = field.describe(prop.description);
  return field;
}

/** Convert a JSON Schema object into a Zod raw shape the registry can register. */
export function jsonSchemaToZodShape(schema: Record<string, unknown>): z.ZodRawShape {
  const props = schema.properties as Record<string, JsonProp> | undefined;
  if (!props) return {};

  const required = new Set((schema.required as string[] | undefined) ?? []);
  const shape: Record<string, z.ZodTypeAny> = {};

  for (const [key, prop] of Object.entries(props)) {
    let field = fieldFromProp(prop);

    // Upstream builds its schemas with zod `.default()`, which serializes as a
    // *required* property carrying a `default`. Taken literally that forces an
    // agent to pass a value for every defaulted option — `browser_take_screenshot`
    // became uncallable with no arguments because `type` and `scale` are declared
    // this way. Restoring the default reproduces the original zod intent.
    if (prop.default !== undefined) field = field.default(prop.default as never);
    else if (!required.has(key)) field = field.optional();

    shape[key] = field;
  }

  return shape as z.ZodRawShape;
}
