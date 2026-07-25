import { describe, expect, it } from "vitest";
import {
  buildArgs,
  classifyCliOutput,
  classifyEvalOutput,
  cliValue,
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

  it("does not mistake a missing ordinary command for argv corruption", () => {
    // Only a leading dash indicates a leaked launch flag.
    expect(classifyCliOutput('Command "bogus" not found.\n')).toBeUndefined();
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

  it("treats empty output as success", () => {
    expect(classifyEvalOutput("", "undefined")).toBeUndefined();
  });
});

describe("argument grammar", () => {
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
