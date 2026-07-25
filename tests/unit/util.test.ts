import { describe, expect, it } from "vitest";
import { truncateText, truncateList, DEFAULT_TEXT_CAP } from "../../src/util/truncate.js";
import { safeStringify, renderResult, parseCliJson } from "../../src/util/serialize.js";
import {
  UobError,
  argvCorruption,
  cliDisabled,
  cdpPortClosed,
  vaultNotFound,
  toUobError,
} from "../../src/util/errors.js";
import { checkUserFlags } from "../../src/connection/vaults.js";
import { buildArgs, cliValue } from "../../src/connection/cli/exec.js";
import { writeFile, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("truncateText", () => {
  it("passes short text through untouched", () => {
    expect(truncateText("hello")).toEqual({ text: "hello", truncated: false });
  });

  it("flags truncation explicitly and reports the original length", () => {
    const result = truncateText("x".repeat(500), 200);
    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBe(500);
    expect(result.text).toContain("truncated");
    expect(result.text.length).toBeLessThanOrEqual(300);
  });

  it("keeps text exactly at the cap", () => {
    expect(truncateText("x".repeat(DEFAULT_TEXT_CAP)).truncated).toBe(false);
  });
});

describe("truncateList", () => {
  it("reports the true total when capping", () => {
    expect(truncateList([1, 2, 3, 4, 5], 2)).toEqual({ items: [1, 2], truncated: true, total: 5 });
  });

  it("leaves a short list alone", () => {
    expect(truncateList([1], 5)).toEqual({ items: [1], truncated: false, total: 1 });
  });
});

describe("safeStringify", () => {
  it("survives cycles instead of throwing", () => {
    const obj: Record<string, unknown> = { name: "root" };
    obj.self = obj;
    const out = safeStringify(obj);
    expect(out).toContain("[Circular]");
    expect(out).toContain("root");
  });

  it("renders types JSON cannot represent", () => {
    const out = safeStringify({
      big: 10n,
      fn: function namedFn() {},
      sym: Symbol("s"),
      undef: undefined,
      inf: Infinity,
      nan: NaN,
    });
    expect(out).toContain("10n");
    expect(out).toContain("[Function: namedFn]");
    expect(out).toContain("Symbol(s)");
    expect(out).toContain("Infinity");
  });

  it("expands errors into name, message, and stack", () => {
    const out = safeStringify({ err: new Error("boom") });
    expect(out).toContain("boom");
    expect(out).toContain("stack");
  });
});

describe("renderResult", () => {
  it("distinguishes null from undefined", () => {
    expect(renderResult(null).text).toBe("null");
    expect(renderResult(undefined).text).toBe("undefined");
  });

  it("returns strings without JSON quoting", () => {
    expect(renderResult("plain").text).toBe("plain");
  });

  it("serializes objects", () => {
    expect(renderResult({ a: 1 }).text).toContain('"a": 1');
  });
});

describe("parseCliJson", () => {
  it("strips the `=> ` prefix the eval command prepends", () => {
    expect(parseCliJson('=> {"a":1}')).toEqual({ a: 1 });
  });

  it("returns undefined for non-JSON rather than throwing", () => {
    expect(parseCliJson("not json at all")).toBeUndefined();
    expect(parseCliJson("")).toBeUndefined();
  });

  it("treats Obsidian's (no output) sentinel as undefined", () => {
    expect(parseCliJson("(no output)")).toBeUndefined();
  });
});

describe("wrapExpression", () => {
  it("adds an implicit return for a bare expression", async () => {
    const { wrapExpression } = await import("../../src/util/serialize.js");
    expect(wrapExpression("app.vault.getName()")).toBe("return (app.vault.getName());");
  });

  it("preserves the return value of an IIFE used by evaluateJson callers", async () => {
    // The old CLI path did `JSON.stringify((() => { ${code} })())`, which discards
    // an IIFE result. wrapExpression must emit `return (…)` so the value survives.
    const { wrapExpression } = await import("../../src/util/serialize.js");
    const code = "(() => { return { a: 1 }; })()";
    expect(wrapExpression(code)).toBe(`return (${code});`);
  });

  it("leaves statement bodies that already return alone", async () => {
    const { wrapExpression } = await import("../../src/util/serialize.js");
    expect(wrapExpression("const x = 1;\nreturn x;")).toBe("const x = 1;\nreturn x;");
  });
});

describe("CLI argument grammar", () => {
  it("puts vault= first, before the command name", () => {
    expect(buildArgs(["note:open", "path=A.md"], "my-vault")).toEqual([
      "vault=my-vault",
      "note:open",
      "path=A.md",
    ]);
  });

  it("omits vault= when no vault is targeted", () => {
    expect(buildArgs(["version"])).toEqual(["version"]);
    expect(buildArgs(["version"], "")).toEqual(["version"]);
  });

  it("escapes newlines and tabs so a value survives the key=value grammar", () => {
    expect(cliValue("a\nb\tc")).toBe("a\\nb\\tc");
  });
});

describe("checkUserFlags", () => {
  it("flags single-dash tokens, which corrupt CLI argv, and ignores comments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uob-flags-"));
    const path = join(dir, "user-flags.conf");
    await writeFile(path, "# a comment\n-disable-gpu\n--enable-wayland-ime\n");

    const result = await checkUserFlags(path);
    expect(result.exists).toBe(true);
    expect(result.corruptingTokens).toEqual(["-disable-gpu"]);
    expect(result.tokens).toEqual(["-disable-gpu", "--enable-wayland-ime"]);
  });

  it("reports a clean file with no corrupting tokens", async () => {
    const dir = await mkdtemp(join(tmpdir(), "uob-flags-"));
    const path = join(dir, "user-flags.conf");
    await writeFile(path, "--disable-gpu\n--enable-wayland-ime\n");
    expect((await checkUserFlags(path)).corruptingTokens).toEqual([]);
  });

  it("reports a missing file without throwing", async () => {
    const result = await checkUserFlags("/nonexistent/user-flags.conf");
    expect(result.exists).toBe(false);
    expect(result.corruptingTokens).toEqual([]);
  });
});

describe("error contract", () => {
  it("keeps the four precondition states distinguishable by code", () => {
    expect(cliDisabled().code).toBe("CLI_DISABLED");
    expect(cdpPortClosed("http://x").code).toBe("CDP_PORT_CLOSED");
    expect(argvCorruption("/p", ["-x"]).code).toBe("ARGV_CORRUPTION");
  });

  it("carries remediation text and names the fixing tool", () => {
    const err = cliDisabled();
    expect(err.remediation).toBeTruthy();
    expect(err.fixedBy).toBe("obsidian_setup_cli");
    expect(err.toText()).toContain("obsidian_setup_cli");
  });

  it("explains that a running instance must be quit before the debug flag applies", () => {
    expect(cdpPortClosed("http://127.0.0.1:9222").remediation).toMatch(/fully quit/i);
  });

  it("lists the registered vaults so an agent can pick a real one", () => {
    const err = vaultNotFound("typo", ["alpha", "beta"]);
    expect(err.remediation).toContain("alpha");
    expect(err.details?.knownVaults).toEqual(["alpha", "beta"]);
  });

  it("names the offending token and the config file for argv corruption", () => {
    const err = argvCorruption("/home/u/.config/obsidian/user-flags.conf", ["-disable-gpu"]);
    expect(err.message).toContain("-disable-gpu");
    expect(err.remediation).toContain("user-flags.conf");
  });

  it("serializes to JSON with the code and remediation", () => {
    expect(cliDisabled().toJSON()).toMatchObject({
      code: "CLI_DISABLED",
      fixedBy: "obsidian_setup_cli",
    });
  });

  it("normalizes unknown throws without losing the message", () => {
    expect(toUobError(new Error("plain")).code).toBe("INTERNAL");
    expect(toUobError("a string").message).toBe("a string");
    const original = cliDisabled();
    expect(toUobError(original)).toBe(original);
  });

  it("omits absent optional fields from the JSON payload", () => {
    const err = new UobError("INTERNAL", "bare");
    expect(err.toJSON()).toEqual({ code: "INTERNAL", message: "bare" });
  });
});
