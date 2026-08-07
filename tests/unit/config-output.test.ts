import { describe, expect, it } from "vitest";
import { openCodeMcpConfig } from "../../src/config-output.js";

describe("openCodeMcpConfig", () => {
  it("uses absolute executable paths and the OpenCode environment key", () => {
    expect(
      openCodeMcpConfig({
        nodePath: "/opt/node/bin/node",
        entryPath: "/opt/knapper/dist/cli.js",
        environment: { KNAP_LOG_LEVEL: "warn" },
      }),
    ).toEqual({
      $schema: "https://opencode.ai/config.json",
      mcp: {
        knapper: {
          type: "local",
          command: ["/opt/node/bin/node", "/opt/knapper/dist/cli.js"],
          enabled: true,
          environment: { KNAP_LOG_LEVEL: "warn" },
        },
      },
    });
  });
});
