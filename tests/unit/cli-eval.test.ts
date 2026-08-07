import { describe, expect, it } from "vitest";
import {
  buildArgs,
  classifyCliOutput,
  classifyEvalOutput,
  cliValue,
  encodeEvalSource,
} from "../../src/connection/cli/exec.js";

/**
 * Obsidian's CLI reports failures as ordinary stdout with exit code 0, so every
 * error path is a question about the shape of the output rather than about an
 * exception. That makes the classification logic the part worth testing.
 */
describe("classifyCliOutput", () => {
  it("treats ordinary output as success", () => {
    expect(classifyCliOutput("name\tuob-test-vault\n")).toBeUndefined();
  });

  it("names ELECTRON_RUN_AS_NODE rather than surfacing a raw module-not-found stack", () => {
    // What an Electron-based MCP client's inherited env actually produces.
    const err = classifyCliOutput(
      "node:internal/modules/cjs/loader:1393\n  throw err;\n  ^\n\n" +
        "Error: Cannot find module 'electron'\nRequire stack:\n- /usr/lib/obsidian/app.asar/main.js\n",
    );
    expect(err).toBeDefined();
    expect(err?.remediation).toMatch(/ELECTRON_RUN_AS_NODE/);
    // The message must not read as a broken Obsidian install.
    expect(err?.message).not.toMatch(/not found|reinstall/i);
  });

  it("maps the CLI-disabled marker and names the tool that fixes it", () => {
    const err = classifyCliOutput("Command line interface is not enabled.\n");
    expect(err?.code).toBe("CLI_DISABLED");
    expect(err?.fixedBy).toBe("obsidian_setup_cli");
    // It cannot be fixed via the CLI itself, which the remediation must say.
    expect(err?.remediation).toMatch(/cannot be fixed through the CLI/i);
  });

  it("maps the vault-not-found marker and echoes the requested name", () => {
    const err = classifyCliOutput("Vault not found.\n", "nope");
    expect(err?.code).toBe("VAULT_NOT_FOUND");
    expect(err?.details?.requested).toBe("nope");
  });

  it("recognizes argv corruption from a leaked single-dash launch flag", () => {
    const err = classifyCliOutput('Command "-disable-gpu" not found.\n');
    expect(err?.code).toBe("ARGV_CORRUPTION");
    expect(err?.details?.token).toBe("-disable-gpu");
    expect(err?.remediation).toContain("user-flags.conf");
  });

  it("recognizes argv corruption with the live Error: prefix", () => {
    // Measured against Obsidian 1.12.7: unknown commands are prefixed with Error:
    // and often include a trailing hint. Without this, ARGV_CORRUPTION is a false negative.
    const err = classifyCliOutput(
      'Error: Command "-disable-gpu" not found. It may require a plugin to be enabled.\n',
    );
    expect(err?.code).toBe("ARGV_CORRUPTION");
    expect(err?.details?.token).toBe("-disable-gpu");
  });

  it("treats an unknown ordinary command as INVALID_ARGUMENT, not success", () => {
    const err = classifyCliOutput(
      'Error: Command "nosuchcommand" not found. It may require a plugin to be enabled.\n',
    );
    expect(err?.code).toBe("INVALID_ARGUMENT");
    expect(err?.details?.command).toBe("nosuchcommand");
  });

  it("also matches the bare Command-not-found shape without Error:", () => {
    expect(classifyCliOutput('Command "bogus" not found.\n')?.code).toBe("INVALID_ARGUMENT");
  });

  it("maps a missing plugin to PLUGIN_NOT_FOUND", () => {
    const err = classifyCliOutput(
      'Error: Plugin "no-such-plugin-xyz" not found. Use "plugins" to list available plugins.\n',
    );
    expect(err?.code).toBe("PLUGIN_NOT_FOUND");
    expect(err?.details?.pluginId).toBe("no-such-plugin-xyz");
  });

  it("maps a missing required parameter", () => {
    const err = classifyCliOutput(
      "Error: Missing required parameter: code\nUsage: eval code=<javascript>\n",
    );
    expect(err?.code).toBe("INVALID_ARGUMENT");
    expect(err?.message).toMatch(/Missing required parameter/);
  });

  it("treats other Error: prefixed CLI stdout as failure", () => {
    expect(classifyCliOutput("Error: something went wrong\n")?.code).toBe("INVALID_ARGUMENT");
  });

  it("leaves bare Error: lines alone in eval mode so throws stay EVAL_FAILED", () => {
    expect(
      classifyCliOutput("Error: boom\n", undefined, { allowEvalErrors: true }),
    ).toBeUndefined();
  });
});

describe("classifyEvalOutput", () => {
  it("treats a `=> ` prefixed result as success", () => {
    expect(classifyEvalOutput("=> uob-test-vault\n", "app.vault.getName()")).toBeUndefined();
  });

  it("raises EVAL_FAILED for a bare thrown error", () => {
    const err = classifyEvalOutput("Error: boom\n", 'throw new Error("boom")');
    expect(err?.code).toBe("EVAL_FAILED");
    expect(err?.message).toContain("boom");
  });

  it("recognizes other error constructors", () => {
    expect(classifyEvalOutput("ReferenceError: x is not defined\n", "x")?.code).toBe("EVAL_FAILED");
    expect(classifyEvalOutput("TypeError: bad\n", "y")?.code).toBe("EVAL_FAILED");
  });

  it("does not mistake a returned error-shaped string for a throw", () => {
    // The `=> ` prefix is the only thing separating a returned value from a throw.
    expect(classifyEvalOutput("=> Error: this is just a string\n", '"..."')).toBeUndefined();
  });

  it("marks the failure as in-page rather than a transport problem", () => {
    const err = classifyEvalOutput("Error: boom\n", "code");
    expect(err?.remediation).toMatch(/not a connection failure/i);
  });

  it("treats empty output and Obsidian's (no output) sentinel as success", () => {
    expect(classifyEvalOutput("", "undefined")).toBeUndefined();
    expect(classifyEvalOutput("(no output)", "undefined")).toBeUndefined();
  });
});

describe("argument grammar", () => {
  it("runs a one-line statement body with an explicit return", async () => {
    const encoded = encodeEvalSource("const value = 41; return value + 1;");
    await expect(Function(`return (${encoded})`)()).resolves.toBe(42);
  });

  it("preserves a one-line bare expression result", async () => {
    const encoded = encodeEvalSource("40 + 2");
    await expect(Function(`return (${encoded})`)()).resolves.toBe(42);
  });

  it("supports top-level await", async () => {
    const encoded = encodeEvalSource("await Promise.resolve(42)");
    await expect(Function(`return (${encoded})`)()).resolves.toBe(42);
  });

  it("places vault= first, ahead of the command name", () => {
    expect(buildArgs(["note:open", "path=A.md"], "v")).toEqual([
      "vault=v",
      "note:open",
      "path=A.md",
    ]);
  });

  it("escapes newlines and tabs so a value survives key=value parsing", () => {
    expect(cliValue("a\nb\tc")).toBe("a\\nb\\tc");
  });
});
