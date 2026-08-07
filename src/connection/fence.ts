/**
 * The vault fence: the single place that decides which vault knapper may touch.
 *
 * knapper drives a live Obsidian holding someone's real notes, so every transport
 * has to resolve a target *before* it acts, and refuse when it cannot. The two
 * failure modes this exists to kill are both silent:
 *
 *  - The Obsidian CLI with no `vault=` token operates on whichever vault the user
 *    last focused. A missing token is not an error, it is a coin flip.
 *  - `PlaywrightSession.page()` used to fall back to "first main window" when no
 *    window matched, so a pin at a scratch vault could drive a real one.
 *
 * Existing-vault authorization is an external record under `KNAP_HOME`, created
 * only by the out-of-band `knapper authorize` command. A private workspace scratch
 * vault is authorized by its exact verified session layout. No MCP tool and no file
 * inside a vault can grant authorization. See `src/authorize.ts`.
 */

import { resolve as resolvePath } from "node:path";
import { obsidianConfigPath } from "../config.js";
import type { Logger } from "../util/logger.js";
import { vaultNotAuthorized, vaultNotFound, vaultTargetAmbiguous } from "../util/errors.js";
import {
  findVaultEntry,
  markerGrant,
  readGlobalConfig,
  readManagedMarker,
  type MarkerGrant,
  type VaultEntry,
} from "./vaults.js";

export interface AuthorizedVault {
  name: string;
  id: string;
  path: string;
  grant: MarkerGrant;
}

/** A registered vault plus whether knapper may touch it. Feeds doctor and status. */
export interface VaultAuthorizationStatus {
  name: string;
  path: string;
  open: boolean;
  authorized: boolean;
  grant?: MarkerGrant;
}

export interface VaultFenceOptions {
  /** Session default from `--vault` / `OBSIDIAN_VAULT`. A preference, not a grant. */
  defaultVault?: string;
  logger: Logger;
  configPath?: string;
  /** Environment that selects Knapper's external authorization registry. */
  env?: NodeJS.ProcessEnv;
  /** Exact private-session scratch vault, authorized by its verified layout. */
  sessionVaultPath?: string;
}

/**
 * Positive marker reads are cached briefly so a burst of tool calls does not
 * re-stat the same file. Negatives are never cached: `knapper authorize` runs in a
 * separate process, so a fresh grant has to take effect without restarting the
 * server, and `knapper revoke` has to bite within one cache window.
 */
const MARKER_TTL_MS = 5000;
const REGISTRY_TTL_MS = 1000;

export class VaultFence {
  private markerCache = new Map<string, { grant: MarkerGrant; at: number }>();
  private registryCache?: { vaults: VaultEntry[]; at: number };
  private warnedSoleVault?: string;

  constructor(private readonly opts: VaultFenceOptions) {}

  /** Drop every cached decision. Called after a grant changes underneath us. */
  invalidate(): void {
    this.markerCache.clear();
    this.registryCache = undefined;
  }

  private async registry(): Promise<VaultEntry[]> {
    const cached = this.registryCache;
    if (cached && Date.now() - cached.at < REGISTRY_TTL_MS) return cached.vaults;
    const config = await readGlobalConfig(this.opts.configPath ?? obsidianConfigPath());
    const vaults = config?.vaults ?? [];
    this.registryCache = { vaults, at: Date.now() };
    return vaults;
  }

  private async grantFor(vaultPath: string): Promise<MarkerGrant | undefined> {
    const key = resolvePath(vaultPath);
    if (
      this.opts.sessionVaultPath !== undefined &&
      key === resolvePath(this.opts.sessionVaultPath)
    ) {
      return "created";
    }
    const cached = this.markerCache.get(key);
    if (cached && Date.now() - cached.at < MARKER_TTL_MS) return cached.grant;

    const marker = await readManagedMarker(key, this.opts.env ?? process.env);
    if (!marker) {
      // Deliberately not cached — see MARKER_TTL_MS.
      this.markerCache.delete(key);
      return undefined;
    }
    const grant = markerGrant(marker);
    this.markerCache.set(key, { grant, at: Date.now() });
    return grant;
  }

  /** Every registered vault knapper is allowed to touch. */
  async list(): Promise<AuthorizedVault[]> {
    const entries = await this.registry();
    const checked = await Promise.all(
      entries.map(async (entry) => {
        if (entry.path === "") return undefined;
        const grant = await this.grantFor(entry.path);
        if (grant === undefined) return undefined;
        return { name: entry.name, id: entry.id, path: resolvePath(entry.path), grant };
      }),
    );
    return checked.filter((v): v is AuthorizedVault => v !== undefined);
  }

  /** Every registered vault with its authorization state. Never throws. */
  async status(): Promise<VaultAuthorizationStatus[]> {
    const entries = await this.registry();
    return Promise.all(
      entries.map(async (entry) => {
        const grant = entry.path === "" ? undefined : await this.grantFor(entry.path);
        return {
          name: entry.name,
          path: entry.path,
          open: entry.open,
          authorized: grant !== undefined,
          ...(grant !== undefined ? { grant } : {}),
        };
      }),
    );
  }

  /** Authorization for a vault by name or id, or undefined. Never throws. */
  async isAuthorized(nameOrId: string): Promise<AuthorizedVault | undefined> {
    const entries = await this.registry();
    const entry = findVaultEntry(entries, nameOrId);
    if (!entry || entry.path === "") return undefined;
    const grant = await this.grantFor(entry.path);
    if (grant === undefined) return undefined;
    return { name: entry.name, id: entry.id, path: resolvePath(entry.path), grant };
  }

  /**
   * Authorization for a filesystem path, for the one caller that has a path rather
   * than a name: `reset-state` reads `app.vault.adapter.basePath` and writes
   * `data.json` straight to disk, bypassing both transports.
   */
  async isPathAuthorized(vaultPath: string): Promise<AuthorizedVault | undefined> {
    const target = resolvePath(vaultPath);
    const grant = await this.grantFor(target);
    if (grant === undefined) return undefined;
    const entry = (await this.registry()).find(
      (v) => v.path !== "" && resolvePath(v.path) === target,
    );
    return {
      name: entry?.name ?? target.split("/").pop() ?? target,
      id: entry?.id ?? "",
      path: target,
      grant,
    };
  }

  /**
   * The vault a call must target, or an error explaining why none can be chosen.
   *
   * Precedence: an explicit argument, then the session default, then — only when
   * exactly one vault is authorized — that one. More than one and we refuse rather
   * than guess; guessing is what the CLI already does badly.
   */
  async resolve(requested?: string): Promise<AuthorizedVault> {
    const wanted = requested !== undefined && requested !== "" ? requested : this.opts.defaultVault;

    if (wanted !== undefined && wanted !== "") {
      const authorized = await this.isAuthorized(wanted);
      if (authorized) return authorized;

      const entries = await this.registry();
      const entry = findVaultEntry(entries, wanted);
      if (!entry) {
        throw vaultNotFound(
          wanted,
          entries.map((v) => v.name),
        );
      }
      throw vaultNotAuthorized(
        { name: entry.name, path: entry.path },
        (await this.list()).map((v) => v.name),
      );
    }

    const all = await this.list();
    const sole = all[0];
    if (all.length === 1 && sole !== undefined) {
      // Say which one, once per vault. Silently adopting a target is how an agent
      // ends up confidently writing to the wrong place.
      if (this.warnedSoleVault !== sole.path) {
        this.warnedSoleVault = sole.path;
        this.opts.logger.info("no vault named; using the only authorized vault", {
          vault: sole.name,
          path: sole.path,
        });
      }
      return sole;
    }

    throw vaultTargetAmbiguous(all.map((v) => v.name));
  }
}
