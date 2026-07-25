/**
 * Tool registry with toolset and capability gating.
 *
 * Tools declare the toolset they belong to and the capability they need. The
 * registry skips registration when the toolset is disabled, so a session only
 * carries the tools it can actually use. Capability availability is checked at
 * call time rather than registration time, because a transport can appear or
 * disappear while the server is running (Obsidian restarts, debug port opens).
 */
import { toUobError } from "../util/errors.js";
import { renderResult } from "../util/serialize.js";
function normalize(outcome) {
  if (typeof outcome === "string") {
    return { content: [{ type: "text", text: outcome }] };
  }
  const content = [];
  const text = "text" in outcome ? outcome.text : undefined;
  const json = "json" in outcome ? outcome.json : undefined;
  if (text !== undefined && text !== "") {
    content.push({ type: "text", text });
  }
  // Structured payload is appended as fenced JSON so agents get machine-readable
  // data without needing a second call, while still reading naturally as text.
  if (json !== undefined) {
    const rendered = renderResult(json);
    content.push({ type: "text", text: `\`\`\`json\n${rendered.text}\n\`\`\`` });
  }
  if ("images" in outcome && outcome.images) {
    for (const img of outcome.images) {
      content.push({ type: "image", data: img.data, mimeType: img.mimeType });
    }
  }
  if (content.length === 0) {
    content.push({ type: "text", text: "(no output)" });
  }
  const isError = "isError" in outcome ? outcome.isError : undefined;
  return isError ? { content, isError: true } : { content };
}
function errorResult(err) {
  return {
    content: [
      { type: "text", text: err.toText() },
      { type: "text", text: `\`\`\`json\n${JSON.stringify(err.toJSON(), null, 2)}\n\`\`\`` },
    ],
    isError: true,
  };
}
export class ToolRegistry {
  enabledToolsets;
  logger;
  definitions = new Map();
  constructor(enabledToolsets, logger) {
    this.enabledToolsets = enabledToolsets;
    this.logger = logger;
  }
  /** Register a tool, or skip it when its toolset is disabled. */
  add(def) {
    if (!this.enabledToolsets.has(def.toolset)) {
      this.logger.debug(`skipping tool (toolset disabled)`, {
        tool: def.name,
        toolset: def.toolset,
      });
      return;
    }
    if (this.definitions.has(def.name)) {
      throw new Error(`Duplicate tool registration: ${def.name}`);
    }
    this.definitions.set(def.name, def);
  }
  addAll(defs) {
    for (const def of defs) this.add(def);
  }
  names() {
    return [...this.definitions.keys()].sort();
  }
  get(name) {
    return this.definitions.get(name);
  }
  /** Tools grouped by toolset, for diagnostics. */
  byToolset() {
    const out = {};
    for (const def of this.definitions.values()) {
      (out[def.toolset] ??= []).push(def.name);
    }
    for (const list of Object.values(out)) list.sort();
    return out;
  }
  /**
   * Bind every registered tool onto an MCP server, wrapping each handler so that
   * connection setup and error mapping live in exactly one place.
   */
  bind(server) {
    for (const def of this.definitions.values()) {
      const config = { description: def.description };
      if (def.inputSchema) config.inputSchema = def.inputSchema;
      if (def.annotations) config.annotations = def.annotations;
      server.registerTool(def.name, config, async (args) => {
        const started = Date.now();
        try {
          const outcome = await def.handler(args ?? {});
          this.logger.debug("tool ok", { tool: def.name, ms: Date.now() - started });
          return normalize(outcome);
        } catch (e) {
          const err = toUobError(e);
          this.logger.warn("tool failed", {
            tool: def.name,
            code: err.code,
            ms: Date.now() - started,
          });
          return errorResult(err);
        }
      });
    }
    this.logger.info(`registered ${this.definitions.size} tools`, this.byToolset());
  }
}
//# sourceMappingURL=registry.js.map
