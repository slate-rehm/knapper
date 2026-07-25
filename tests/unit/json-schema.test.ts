import { describe, expect, it } from "vitest";
import { z } from "zod";
import { jsonSchemaToZodShape } from "../../src/browser/json-schema.js";

function parse(schema: Record<string, unknown>, input: unknown) {
  return z.object(jsonSchemaToZodShape(schema)).safeParse(input);
}

describe("jsonSchemaToZodShape", () => {
  it("treats a property with a default as satisfiable without an argument", () => {
    // @playwright/mcp builds schemas with zod `.default()`, which serializes as a
    // *required* property carrying a `default`. Honoring `required` literally made
    // browser_take_screenshot uncallable with no arguments.
    const schema = {
      type: "object",
      properties: {
        type: { type: "string", enum: ["png", "jpeg"], default: "png" },
        scale: { type: "string", enum: ["css", "device"], default: "css" },
      },
      required: ["type", "scale"],
    };

    const result = parse(schema, {});
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ type: "png", scale: "css" });
  });

  it("still enforces a required property that has no default", () => {
    const schema = {
      type: "object",
      properties: { target: { type: "string" } },
      required: ["target"],
    };
    expect(parse(schema, {}).success).toBe(false);
    expect(parse(schema, { target: "e5" }).success).toBe(true);
  });

  it("leaves an unrequired property optional", () => {
    const schema = { type: "object", properties: { element: { type: "string" } } };
    expect(parse(schema, {}).success).toBe(true);
  });

  it("maps the JSON Schema primitive types", () => {
    const schema = {
      type: "object",
      properties: {
        s: { type: "string" },
        n: { type: "number" },
        i: { type: "integer" },
        b: { type: "boolean" },
        a: { type: "array", items: { type: "string" } },
        o: { type: "object" },
      },
    };
    const result = parse(schema, { s: "x", n: 1.5, i: 2, b: true, a: ["y"], o: { k: 1 } });
    expect(result.success).toBe(true);
  });

  it("rejects a value outside an enum", () => {
    const schema = { type: "object", properties: { t: { type: "string", enum: ["png", "jpeg"] } } };
    expect(parse(schema, { t: "gif" }).success).toBe(false);
  });

  it("returns an empty shape for a schema with no properties", () => {
    expect(jsonSchemaToZodShape({ type: "object" })).toEqual({});
  });

  it("preserves descriptions through to the schema an agent actually sees", () => {
    // zod v4 keeps `.describe()` on the inner type when `.optional()` wraps it, so
    // assert against the generated JSON Schema rather than the wrapper object.
    const shape = jsonSchemaToZodShape({
      type: "object",
      properties: {
        target: { type: "string", description: "Snapshot ref or selector" },
        type: { type: "string", enum: ["png", "jpeg"], default: "png", description: "Format" },
      },
    });

    const generated = z.toJSONSchema(z.object(shape), { io: "input" }) as {
      properties: Record<string, { description?: string }>;
    };
    expect(generated.properties.target?.description).toBe("Snapshot ref or selector");
    expect(generated.properties.type?.description).toBe("Format");
  });
});
