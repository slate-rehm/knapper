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

const vaultOpt = { vault: z.string().optional() };
const fileRef = {
  file: z.string().optional(),
  path: z.string().optional(),
  ...vaultOpt,
};

export function registerAuthoringTools(ctx: ServerContext): void {
  const { registry, router, config } = ctx;

  registry.add({
    name: "obsidian_themes",
    toolset: "authoring",
    capability: "cliCommand",
    description: "List installed community themes. " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      versions: z.boolean().optional(),
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
      return cliOutcome(stdout);
    },
  });

  registry.add({
    name: "obsidian_theme",
    toolset: "authoring",
    capability: "cliCommand",
    description: "Show active theme or details for a named theme. " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      name: z.string().optional(),
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
    description: "Switch the active theme. " + CLOSED_VAULT_WARNING,
    inputSchema: {
      name: z.string().describe("Theme name"),
      ...vaultOpt,
    },
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
    description: "List CSS snippets and enabled state. " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: vaultOpt,
    handler: async (args) => {
      const { stdout } = await runCli(router, {
        command: "snippets",
        vault: vaultName(args, config),
      });
      return cliOutcome(stdout);
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
      name: z.string().optional(),
      total: z.boolean().optional(),
      counts: z.boolean().optional(),
      format: z.enum(["yaml", "json", "tsv"]).optional(),
      active: z.boolean().optional(),
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
    description: "Set a frontmatter property on a file. " + CLOSED_VAULT_WARNING,
    inputSchema: {
      name: z.string(),
      value: z.string(),
      type: z.enum(["text", "list", "number", "checkbox", "date", "datetime"]).optional(),
      ...fileRef,
    },
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
    description: "Remove a frontmatter property. " + CLOSED_VAULT_WARNING,
    inputSchema: {
      name: z.string(),
      ...fileRef,
    },
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
    description: "Read one property value from a file. " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      name: z.string(),
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
    description: "List tags in the vault or for a file. " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      ...fileRef,
      counts: z.boolean().optional(),
      sort: z.enum(["count"]).optional(),
      format: z.enum(["json", "tsv", "csv"]).optional(),
      active: z.boolean().optional(),
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
    description: "List markdown tasks (- [ ] / - [x]). " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      ...fileRef,
      done: z.boolean().optional(),
      todo: z.boolean().optional(),
      verbose: z.boolean().optional(),
      format: z.enum(["json", "tsv", "csv"]).optional(),
      active: z.boolean().optional(),
      daily: z.boolean().optional(),
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
      "Open or read today's daily note (requires daily-notes plugin). " + CLOSED_VAULT_WARNING,
    inputSchema: {
      read: z.boolean().optional(),
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
    description: "Append to the daily note. " + CLOSED_VAULT_WARNING,
    inputSchema: {
      content: z.string(),
      inline: z.boolean().optional(),
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
    description: "List template files. " + CLOSED_VAULT_WARNING,
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
    description: "List bookmarks. " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      total: z.boolean().optional(),
      verbose: z.boolean().optional(),
      format: z.enum(["json", "tsv", "csv"]).optional(),
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
    description: "Show heading outline for a file. " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      ...fileRef,
      format: z.enum(["tree", "md", "json"]).optional(),
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
    description: "List local file history versions. " + CLOSED_VAULT_WARNING,
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
