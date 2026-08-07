import { resolve } from "node:path";

export interface OpenCodeMcpConfigOptions {
  nodePath: string;
  entryPath: string;
  environment?: Record<string, string>;
}

/** Build an OpenCode MCP entry without relying on shell shims or PATH lookup. */
export function openCodeMcpConfig(options: OpenCodeMcpConfigOptions): Record<string, unknown> {
  return {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      knapper: {
        type: "local",
        command: [resolve(options.nodePath), resolve(options.entryPath)],
        enabled: true,
        environment: options.environment ?? {},
      },
    },
  };
}
