/**
 * Vault file and note operations (toolset: vault).
 */

import { z } from "zod";
import type { ServerContext } from "../server.js";
import {
  CLOSED_VAULT_WARNING,
  cliOutcome,
  contentOutcome,
  evalJson,
  pushFileTarget,
  pushFlag,
  pushKv,
  runCli,
  vaultName,
} from "../obsidian/helpers.js";
import { cliValue } from "../connection/cli/exec.js";

const vaultOpt = { vault: z.string().optional().describe("Target vault name") };

export function registerVaultTools(ctx: ServerContext): void {
  const { registry, router, config } = ctx;

  const fileRef = {
    file: z.string().optional().describe("File name (wikilink resolution)"),
    path: z.string().optional().describe("Exact vault path"),
    ...vaultOpt,
  };

  registry.add({
    name: "obsidian_files",
    toolset: "vault",
    capability: "cliCommand",
    description:
      "List files in the vault, optionally by folder or extension. " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      folder: z.string().optional(),
      ext: z.string().optional(),
      total: z.boolean().optional(),
      ...vaultOpt,
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushKv(tokens, "folder", args.folder as string | undefined);
      pushKv(tokens, "ext", args.ext as string | undefined);
      pushFlag(tokens, "total", args.total as boolean | undefined);
      const { stdout, parsed } = await runCli(router, {
        command: "files",
        args: tokens,
        vault: vaultName(args, config),
        json: false,
      });
      return cliOutcome(stdout, parsed);
    },
  });

  registry.add({
    name: "obsidian_folders",
    toolset: "vault",
    capability: "cliCommand",
    description: "List folders in the vault. " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      folder: z.string().optional(),
      total: z.boolean().optional(),
      ...vaultOpt,
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushKv(tokens, "folder", args.folder as string | undefined);
      pushFlag(tokens, "total", args.total as boolean | undefined);
      const { stdout } = await runCli(router, {
        command: "folders",
        args: tokens,
        vault: vaultName(args, config),
      });
      return cliOutcome(stdout);
    },
  });

  registry.add({
    name: "obsidian_read",
    toolset: "vault",
    capability: "cliCommand",
    description:
      "Read a note's markdown content. Prefer over obsidian_eval for file bodies. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: fileRef,
    handler: async (args) => {
      const tokens: string[] = [];
      pushFileTarget(tokens, args.file as string | undefined, args.path as string | undefined);
      const { stdout } = await runCli(router, {
        command: "read",
        args: tokens,
        vault: vaultName(args, config),
      });
      return cliOutcome(stdout);
    },
  });

  registry.add({
    name: "obsidian_create",
    toolset: "vault",
    capability: "cliCommand",
    description: "Create a new note. " + CLOSED_VAULT_WARNING,
    inputSchema: {
      name: z.string().optional(),
      path: z.string().optional(),
      content: z.string().optional(),
      template: z.string().optional(),
      overwrite: z.boolean().optional(),
      open: z.boolean().optional(),
      ...vaultOpt,
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushKv(tokens, "name", args.name as string | undefined);
      pushKv(tokens, "path", args.path as string | undefined);
      pushKv(tokens, "content", args.content as string | undefined);
      pushKv(tokens, "template", args.template as string | undefined);
      pushFlag(tokens, "overwrite", args.overwrite as boolean | undefined);
      pushFlag(tokens, "open", args.open as boolean | undefined);
      const { stdout } = await runCli(router, {
        command: "create",
        args: tokens,
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Created");
    },
  });

  registry.add({
    name: "obsidian_append",
    toolset: "vault",
    capability: "cliCommand",
    description: "Append markdown to a file. " + CLOSED_VAULT_WARNING,
    inputSchema: {
      ...fileRef,
      content: z.string().describe("Content to append"),
      inline: z.boolean().optional(),
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushFileTarget(tokens, args.file as string | undefined, args.path as string | undefined);
      tokens.push(`content=${cliValue(args.content as string)}`);
      pushFlag(tokens, "inline", args.inline as boolean | undefined);
      const { stdout } = await runCli(router, {
        command: "append",
        args: tokens,
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Appended");
    },
  });

  registry.add({
    name: "obsidian_prepend",
    toolset: "vault",
    capability: "cliCommand",
    description: "Prepend markdown to a file. " + CLOSED_VAULT_WARNING,
    inputSchema: {
      ...fileRef,
      content: z.string(),
      inline: z.boolean().optional(),
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushFileTarget(tokens, args.file as string | undefined, args.path as string | undefined);
      tokens.push(`content=${cliValue(args.content as string)}`);
      pushFlag(tokens, "inline", args.inline as boolean | undefined);
      const { stdout } = await runCli(router, {
        command: "prepend",
        args: tokens,
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Prepended");
    },
  });

  registry.add({
    name: "obsidian_delete",
    toolset: "vault",
    capability: "cliCommand",
    description: "Delete a file (trash by default). " + CLOSED_VAULT_WARNING,
    annotations: { destructiveHint: true },
    inputSchema: {
      ...fileRef,
      permanent: z.boolean().optional(),
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushFileTarget(tokens, args.file as string | undefined, args.path as string | undefined);
      pushFlag(tokens, "permanent", args.permanent as boolean | undefined);
      const { stdout } = await runCli(router, {
        command: "delete",
        args: tokens,
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Deleted");
    },
  });

  registry.add({
    name: "obsidian_move",
    toolset: "vault",
    capability: "cliCommand",
    description: "Move or rename a file. " + CLOSED_VAULT_WARNING,
    annotations: { destructiveHint: true },
    inputSchema: {
      ...fileRef,
      to: z.string().describe("Destination folder or path"),
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushFileTarget(tokens, args.file as string | undefined, args.path as string | undefined);
      pushKv(tokens, "to", args.to as string);
      const { stdout } = await runCli(router, {
        command: "move",
        args: tokens,
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Moved");
    },
  });

  registry.add({
    name: "obsidian_rename",
    toolset: "vault",
    capability: "cliCommand",
    description: "Rename a file. " + CLOSED_VAULT_WARNING,
    inputSchema: {
      ...fileRef,
      to: z.string().describe("New name or path"),
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushFileTarget(tokens, args.file as string | undefined, args.path as string | undefined);
      pushKv(tokens, "to", args.to as string);
      const { stdout } = await runCli(router, {
        command: "rename",
        args: tokens,
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Renamed");
    },
  });

  registry.add({
    name: "obsidian_diff",
    toolset: "vault",
    capability: "cliCommand",
    description: "Show diff between file versions (local history). " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: fileRef,
    handler: async (args) => {
      const tokens: string[] = [];
      pushFileTarget(tokens, args.file as string | undefined, args.path as string | undefined);
      const { stdout } = await runCli(router, {
        command: "diff",
        args: tokens,
        vault: vaultName(args, config),
      });
      return cliOutcome(stdout);
    },
  });

  registry.add({
    name: "obsidian_open",
    toolset: "vault",
    capability: "cliCommand",
    description: "Open a file in the editor (may focus or spawn tabs). " + CLOSED_VAULT_WARNING,
    inputSchema: {
      ...fileRef,
      newtab: z.boolean().optional(),
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushFileTarget(tokens, args.file as string | undefined, args.path as string | undefined);
      pushFlag(tokens, "newtab", args.newtab as boolean | undefined);
      const { stdout } = await runCli(router, {
        command: "open",
        args: tokens,
        vault: vaultName(args, config),
      });
      return contentOutcome(stdout, "Opened");
    },
  });

  registry.add({
    name: "obsidian_recents",
    toolset: "vault",
    capability: "cliCommand",
    description: "List recently opened files. " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      limit: z.number().optional(),
      ...vaultOpt,
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushKv(tokens, "limit", args.limit as number | undefined);
      const { stdout, parsed } = await runCli(router, {
        command: "recents",
        args: tokens,
        vault: vaultName(args, config),
        json: true,
      });
      return cliOutcome(stdout, parsed);
    },
  });

  registry.add({
    name: "obsidian_tabs",
    toolset: "vault",
    capability: "cliCommand",
    description: "List open tabs including sidebar panels when all=true. " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      ids: z.boolean().optional(),
      all: z.boolean().optional(),
      ...vaultOpt,
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushFlag(tokens, "ids", args.ids as boolean | undefined);
      pushFlag(tokens, "all", args.all as boolean | undefined);
      const { stdout } = await runCli(router, {
        command: "tabs",
        args: tokens,
        vault: vaultName(args, config),
      });
      return cliOutcome(stdout);
    },
  });

  registry.add({
    name: "obsidian_search",
    toolset: "vault",
    capability: "cliCommand",
    description:
      "Full-text search via Obsidian's `search` CLI (not a path substring stub). Use path= to limit " +
      "to a folder. Falls back to metadata cache scan only if the command fails. " +
      CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      query: z.string(),
      path: z.string().optional().describe("Folder path filter"),
      limit: z.number().optional(),
      case: z.boolean().optional(),
      ...vaultOpt,
    },
    handler: async (args) => {
      const v = vaultName(args, config);
      const tokens: string[] = [`query=${cliValue(args.query as string)}`];
      pushKv(tokens, "path", args.path as string | undefined);
      pushKv(tokens, "limit", args.limit as number | undefined);
      pushFlag(tokens, "case", args.case as boolean | undefined);
      tokens.push("format=json");

      try {
        const { stdout, parsed } = await runCli(router, {
          command: "search",
          args: tokens,
          vault: v,
          json: true,
        });
        return cliOutcome(stdout, parsed);
      } catch {
        const q = args.query as string;
        const code = `((q) => {
          const hits = [];
          for (const f of app.vault.getMarkdownFiles()) {
            const cache = app.metadataCache.getFileCache(f);
            const text = cache ? JSON.stringify(cache) : "";
            if (f.path.includes(q) || text.includes(q)) hits.push(f.path);
          }
          return hits;
        })(${JSON.stringify(q)})`;
        const value = await evalJson<string[]>(router, code);
        return { text: value.join("\n") || "(no results)", json: { data: value, fallback: true } };
      }
    },
  });

  const graphSchema = {
    ...fileRef,
    counts: z.boolean().optional(),
    total: z.boolean().optional(),
    format: z.enum(["json", "tsv", "csv"]).optional(),
  };

  registry.add({
    name: "obsidian_backlinks",
    toolset: "vault",
    capability: "cliCommand",
    description: "List backlinks to a note. " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: graphSchema,
    handler: async (args) => {
      const tokens: string[] = [];
      pushFileTarget(tokens, args.file as string | undefined, args.path as string | undefined);
      pushFlag(tokens, "counts", args.counts as boolean | undefined);
      pushFlag(tokens, "total", args.total as boolean | undefined);
      pushKv(tokens, "format", args.format as string | undefined);
      const { stdout, parsed } = await runCli(router, {
        command: "backlinks",
        args: tokens,
        vault: vaultName(args, config),
        json: args.format === "json" || args.format === undefined,
      });
      return cliOutcome(stdout, parsed);
    },
  });

  registry.add({
    name: "obsidian_unresolved",
    toolset: "vault",
    capability: "cliCommand",
    description: "List unresolved wikilinks in the vault. " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      total: z.boolean().optional(),
      counts: z.boolean().optional(),
      verbose: z.boolean().optional(),
      format: z.enum(["json", "tsv", "csv"]).optional(),
      ...vaultOpt,
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushFlag(tokens, "total", args.total as boolean | undefined);
      pushFlag(tokens, "counts", args.counts as boolean | undefined);
      pushFlag(tokens, "verbose", args.verbose as boolean | undefined);
      pushKv(tokens, "format", args.format as string | undefined);
      const { stdout, parsed } = await runCli(router, {
        command: "unresolved",
        args: tokens,
        vault: vaultName(args, config),
        json: true,
      });
      return cliOutcome(stdout, parsed);
    },
  });

  registry.add({
    name: "obsidian_orphans",
    toolset: "vault",
    capability: "cliCommand",
    description: "List notes with no incoming links. " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: {
      total: z.boolean().optional(),
      format: z.enum(["json", "tsv", "csv"]).optional(),
      ...vaultOpt,
    },
    handler: async (args) => {
      const tokens: string[] = [];
      pushFlag(tokens, "total", args.total as boolean | undefined);
      pushKv(tokens, "format", args.format as string | undefined);
      const { stdout, parsed } = await runCli(router, {
        command: "orphans",
        args: tokens,
        vault: vaultName(args, config),
        json: true,
      });
      return cliOutcome(stdout, parsed);
    },
  });

  registry.add({
    name: "obsidian_aliases",
    toolset: "vault",
    capability: "cliCommand",
    description: "List aliases in the vault or for one file. " + CLOSED_VAULT_WARNING,
    annotations: { readOnlyHint: true },
    inputSchema: graphSchema,
    handler: async (args) => {
      const tokens: string[] = [];
      pushFileTarget(tokens, args.file as string | undefined, args.path as string | undefined);
      pushFlag(tokens, "total", args.total as boolean | undefined);
      pushKv(tokens, "format", args.format as string | undefined);
      const { stdout, parsed } = await runCli(router, {
        command: "aliases",
        args: tokens,
        vault: vaultName(args, config),
        json: true,
      });
      return cliOutcome(stdout, parsed);
    },
  });
}
