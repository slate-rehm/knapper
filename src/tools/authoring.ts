/**
 * Authoring helpers: themes, metadata, tasks, templates (toolset: authoring).
 */

import { z } from "zod";
import type { ServerContext } from "../server.js";
import {
  CLOSED_VAULT_WARNING,
  cliOutcome,
  contentOutcome,
  pushFileTarget,
  pushFlag,
  pushKv,
  runCli,
  vaultName,
} from "../obsidian/helpers.js";
import { cliValue } from "../connection/cli/exec.js";

const vaultOpt = {
  vault: z.string().optional().describe("Target vault name; overrides the session default"),
};
const fileRef = {
  file: z.string().optional().describe("File name (wikilink resolution)"),
  path: z.string().optional().describe("Exact vault-relative path"),
  ...vaultOpt,
};

function listOutcome(kind: "themes" | "snippets", stdout: string) {
  const trimmed = stdout.trim();
  const values = (trimmed === "" || trimmed === "(no output)" ? "" : trimmed)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return {
    text: values.join("\n") || `(no ${kind})`,
    json: { count: values.length, [kind]: values },
  };
}

export function registerAuthoringTools(ctx: ServerContext): void {
  const { registry, router, config } = ctx;

  registry.add({
    name: "obsidian_themes",
    toolset: "authoring",
    capability: "cliCommand",
    description:
      "List installed community themes. Prefer over guessing theme ids before obsidian_theme_set. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      versions: z.boolean().optional().describe("Include installed theme versions"),
      ...vaultOpt,
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushFlag(tokens, "versions", args.versions as boolean | undefined);
      const { stdout } = await runCli(router, {
        command: "themes",
        args: tokens,
        vault: vaultName(args, config),
      });
      return listOutcome("themes", stdout);
    },
  });

  registry.add({
    name: "obsidian_theme",
    toolset: "authoring",
    capability: "cliCommand",
    description:
      "Show the active theme, or details for a named theme. Use obsidian_themes to list candidates. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      name: z.string().optional().describe("Theme name; omit to show the active theme"),
      ...vaultOpt,
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushKv(tokens, "name", args.name as string | undefined);
      const { stdout } = await runCli(router, {
        command: "theme",
        args: tokens,
        vault: vaultName(args, config),
      });
      return cliOutcome(stdout);
    },
  });

  registry.add({
    name: "obsidian_theme_set",
    toolset: "authoring",
    capability: "cliCommand",
    description:
      "Switch the active theme (mutates appearance). Confirm the name with obsidian_themes first. " +
      CLOSED_VAULT_WARNING,
    inputSchema: {
      name: z.string().describe("Theme name"),
      ...vaultOpt,
    },
    // Overwrites the user's chosen appearance with no undo.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    handler: async (args) => {
      const { stdout } = await runCli(router, {
        command: "theme:set",
        args: [`name=${args.name as string}`],
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Theme set");
    },
  });

  registry.add({
    name: "obsidian_snippets",
    toolset: "authoring",
    capability: "cliCommand",
    description:
      "List CSS snippets and whether each is enabled. Useful before toggling snippet files on disk. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: vaultOpt,
    handler: async (args) => {
      const { stdout } = await runCli(router, {
        command: "snippets",
        vault: vaultName(args, config),
      });
      return listOutcome("snippets", stdout);
    },
  });

  registry.add({
    name: "obsidian_properties",
    toolset: "authoring",
    capability: "cliCommand",
    description:
      "List frontmatter properties in the vault or for one file. " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      ...fileRef,
      name: z.string().optional().describe("Filter to a single property name"),
      total: z.boolean().optional().describe("Return only a total count"),
      counts: z.boolean().optional().describe("Include usage counts"),
      format: z.enum(["yaml", "json", "tsv"]).optional().describe("Output format"),
      active: z.boolean().optional().describe("Limit to the active file"),
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushFileTarget(tokens, args.file as string | undefined, args.path as string | undefined);
      pushKv(tokens, "name", args.name as string | undefined);
      pushFlag(tokens, "total", args.total as boolean | undefined);
      pushFlag(tokens, "counts", args.counts as boolean | undefined);
      pushKv(tokens, "format", args.format as string | undefined);
      pushFlag(tokens, "active", args.active as boolean | undefined);
      const { stdout, parsed } = await runCli(router, {
        command: "properties",
        args: tokens,
        vault: vaultName(args, config),
        json: args.format === "json",
      });
      return cliOutcome(stdout, parsed);
    },
  });

  registry.add({
    name: "obsidian_property_set",
    toolset: "authoring",
    capability: "cliCommand",
    description:
      "Set a frontmatter property on a file (writes YAML). Prefer over editing markdown by hand. " +
      CLOSED_VAULT_WARNING,
    inputSchema: {
      name: z.string().describe("Frontmatter property name"),
      value: z.string().describe("Property value (list items as CLI grammar requires)"),
      type: z
        .enum(["text", "list", "number", "checkbox", "date", "datetime"])
        .optional()
        .describe("Property type hint for Obsidian"),
      ...fileRef,
    },
    // Overwrites any existing value for that key.
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const tokens = [`name=${args.name as string}`, `value=${cliValue(args.value as string)}`];
      pushKv(tokens, "type", args.type as string | undefined);
      pushFileTarget(tokens, args.file as string | undefined, args.path as string | undefined);
      const { stdout } = await runCli(router, {
        command: "property:set",
        args: tokens,
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Property set");
    },
  });

  registry.add({
    name: "obsidian_property_remove",
    toolset: "authoring",
    capability: "cliCommand",
    description:
      "Remove a frontmatter property from a file (mutates YAML). " + CLOSED_VAULT_WARNING,
    inputSchema: {
      name: z.string().describe("Frontmatter property name to remove"),
      ...fileRef,
    },
    // Deletes user data with no undo.
    annotations: { destructiveHint: true },
    handler: async (args) => {
      const tokens = [`name=${args.name as string}`];
      pushFileTarget(tokens, args.file as string | undefined, args.path as string | undefined);
      const { stdout } = await runCli(router, {
        command: "property:remove",
        args: tokens,
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Property removed");
    },
  });

  registry.add({
    name: "obsidian_property_read",
    toolset: "authoring",
    capability: "cliCommand",
    description:
      "Read one frontmatter property value from a file. Prefer over parsing the whole note. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      name: z.string().describe("Frontmatter property name to read"),
      ...fileRef,
    },
    handler: async (args) => {
      const tokens = [`name=${args.name as string}`];
      pushFileTarget(tokens, args.file as string | undefined, args.path as string | undefined);
      const { stdout } = await runCli(router, {
        command: "property:read",
        args: tokens,
        vault: vaultName(args, config),
      });
      return cliOutcome(stdout);
    },
  });

  registry.add({
    name: "obsidian_tags",
    toolset: "authoring",
    capability: "cliCommand",
    description:
      "List tags in the vault or for a file. Prefer over DOM scraping the tags view. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      ...fileRef,
      counts: z.boolean().optional().describe("Include tag usage counts"),
      sort: z.enum(["count"]).optional().describe("Sort tags by count"),
      format: z.enum(["json", "tsv", "csv"]).optional().describe("Output format (default json)"),
      active: z.boolean().optional().describe("Limit to the active file"),
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushFileTarget(tokens, args.file as string | undefined, args.path as string | undefined);
      pushFlag(tokens, "counts", args.counts as boolean | undefined);
      pushKv(tokens, "sort", args.sort as string | undefined);
      pushKv(tokens, "format", args.format as string | undefined);
      pushFlag(tokens, "active", args.active as boolean | undefined);
      const { stdout, parsed } = await runCli(router, {
        command: "tags",
        args: tokens,
        vault: vaultName(args, config),
        json: true,
      });
      return cliOutcome(stdout, parsed);
    },
  });

  registry.add({
    name: "obsidian_tasks",
    toolset: "authoring",
    capability: "cliCommand",
    description:
      "List markdown checkbox tasks (- [ ] / - [x]) across the vault or one file. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      ...fileRef,
      done: z.boolean().optional().describe("Only completed tasks"),
      todo: z.boolean().optional().describe("Only incomplete tasks"),
      verbose: z.boolean().optional().describe("Include extra task detail"),
      format: z.enum(["json", "tsv", "csv"]).optional().describe("Output format (default json)"),
      active: z.boolean().optional().describe("Limit to the active file"),
      daily: z.boolean().optional().describe("Limit to the daily note"),
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushFileTarget(tokens, args.file as string | undefined, args.path as string | undefined);
      pushFlag(tokens, "done", args.done as boolean | undefined);
      pushFlag(tokens, "todo", args.todo as boolean | undefined);
      pushFlag(tokens, "verbose", args.verbose as boolean | undefined);
      pushKv(tokens, "format", args.format as string | undefined);
      pushFlag(tokens, "active", args.active as boolean | undefined);
      pushFlag(tokens, "daily", args.daily as boolean | undefined);
      const { stdout, parsed } = await runCli(router, {
        command: "tasks",
        args: tokens,
        vault: vaultName(args, config),
        json: true,
      });
      return cliOutcome(stdout, parsed);
    },
  });

  registry.add({
    name: "obsidian_daily",
    toolset: "authoring",
    capability: "cliCommand",
    description:
      "Open today's daily note (default) or read its content with read=true. Requires the daily-notes " +
      "core plugin. Opening focuses the editor. " +
      CLOSED_VAULT_WARNING,
    inputSchema: {
      read: z
        .boolean()
        .optional()
        .describe("When true, read today's note content instead of opening it (default opens)"),
      ...vaultOpt,
    },
    handler: async (args) => {
      const cmd = args.read === true ? "daily:read" : "daily";
      const { stdout } = await runCli(router, {
        command: cmd,
        vault: vaultName(args, config),
      });
      return cliOutcome(stdout);
    },
  });

  registry.add({
    name: "obsidian_daily_append",
    toolset: "authoring",
    capability: "cliCommand",
    description:
      "Append markdown to today's daily note (creates it if needed). Prefer over manual open+type. " +
      CLOSED_VAULT_WARNING,
    inputSchema: {
      content: z.string().describe("Markdown to append to today's daily note"),
      inline: z.boolean().optional().describe("Append inline without a leading newline"),
      ...vaultOpt,
    },
    handler: async (args) => {
      const tokens = [`content=${cliValue(args.content as string)}`];
      pushFlag(tokens, "inline", args.inline as boolean | undefined);
      const { stdout } = await runCli(router, {
        command: "daily:append",
        args: tokens,
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Appended to daily note");
    },
  });

  registry.add({
    name: "obsidian_templates",
    toolset: "authoring",
    capability: "cliCommand",
    description:
      "List template files from the configured templates folder. Errors if no template folder is set. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: vaultOpt,
    handler: async (args) => {
      const { stdout } = await runCli(router, {
        command: "templates",
        vault: vaultName(args, config),
      });
      return cliOutcome(stdout);
    },
  });

  registry.add({
    name: "obsidian_bookmarks",
    toolset: "authoring",
    capability: "cliCommand",
    description: "List bookmarks from the bookmarks core plugin. " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      total: z.boolean().optional().describe("Return only a total count"),
      verbose: z.boolean().optional().describe("Include extra bookmark detail"),
      format: z.enum(["json", "tsv", "csv"]).optional().describe("Output format (default json)"),
      ...vaultOpt,
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushFlag(tokens, "total", args.total as boolean | undefined);
      pushFlag(tokens, "verbose", args.verbose as boolean | undefined);
      pushKv(tokens, "format", args.format as string | undefined);
      const { stdout, parsed } = await runCli(router, {
        command: "bookmarks",
        args: tokens,
        vault: vaultName(args, config),
        json: true,
      });
      return cliOutcome(stdout, parsed);
    },
  });

  registry.add({
    name: "obsidian_outline",
    toolset: "authoring",
    capability: "cliCommand",
    description:
      "Show the heading outline for a file. Prefer over scraping the outline pane DOM. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      ...fileRef,
      format: z.enum(["tree", "md", "json"]).optional().describe("Outline format (default tree)"),
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushFileTarget(tokens, args.file as string | undefined, args.path as string | undefined);
      pushKv(tokens, "format", args.format as string | undefined);
      const { stdout, parsed } = await runCli(router, {
        command: "outline",
        args: tokens,
        vault: vaultName(args, config),
        json: args.format === "json",
      });
      return cliOutcome(stdout, parsed);
    },
  });

  registry.add({
    name: "obsidian_history",
    toolset: "authoring",
    capability: "cliCommand",
    description:
      "List local file history versions for a note (requires file-recovery). Pair with obsidian_diff. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: fileRef,
    handler: async (args) => {
      const tokens: string[] = [];
      pushFileTarget(tokens, args.file as string | undefined, args.path as string | undefined);
      const { stdout } = await runCli(router, {
        command: "history",
        args: tokens,
        vault: vaultName(args, config),
      });
      return cliOutcome(stdout);
    },
  });
}
