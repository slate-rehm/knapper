/**
 * Session keys.
 *
 * A key is a short, legible handle — `feature-x-a3f19c22` — and nothing more. The
 * truth about a session lives in its descriptor on disk.
 *
 * It is deliberately not a self-describing blob encoding the vault, port, and
 * profile paths. Such a key would name a vault, which makes it an
 * authorization-shaped input, and `connection/fence.ts` exists precisely to keep a
 * vault name a *request* rather than a *grant* — every field would have to be
 * re-validated against disk on arrival anyway. It also could not carry the pid,
 * which changes on every restart, and it would not be enumerable, so the reaper
 * could never find an abandoned session without an agent to hand it the key.
 *
 * The random suffix is not decoration: two agents on the *same* branch in the same
 * worktree must get different sessions, so the key cannot be a pure function of the
 * path. Provenance (cwd, branch) is recorded inside the descriptor instead, which
 * appears in internal workspace diagnostics.
 */

import { randomBytes } from "node:crypto";
import { cliSocketPathFor, MAX_SOCKET_PATH_BYTES, sessionPaths } from "../config.js";
import { UobError } from "../util/errors.js";

const SLUG_MAX = 12;
export const SESSION_KEY_RE = /^[a-z0-9][a-z0-9-]{0,20}-[0-9a-f]{8}$/;

/** Reduce arbitrary text to a safe, short path component. */
export function slugify(raw: string): string {
  const slug = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
  return slug === "" ? "session" : slug;
}

/**
 * Validate a key that arrived from an agent, before it is ever joined into a path.
 *
 * This is the only guard between a tool argument and `rm -rf` inside the session
 * root, so it rejects rather than sanitizes: a key that does not match is a bug or
 * an attack, and quietly repairing it would hide both.
 */
export function assertSessionKey(raw: string): string {
  if (!SESSION_KEY_RE.test(raw)) {
    throw new UobError(
      "INVALID_ARGUMENT",
      `"${raw}" is not a valid internal workspace descriptor key.`,
      {
        remediation:
          "Do not repair or reuse this workspace. Create a new isolated workspace and inspect the damaged record manually.",
      },
    );
  }
  return raw;
}

/**
 * Mint a key for a new session, refusing one whose CLI socket path would not fit.
 *
 * `sockaddr_un.sun_path` is 108 bytes and the session root is under `$HOME`, so a
 * long home directory plus a long label can overflow it. Checked here, where the
 * name is chosen, rather than at `bind()` — Obsidian would otherwise fail to bind
 * its socket with an opaque ENAMETOOLONG, minutes later, with nothing pointing back
 * at the label that caused it.
 */
export function mintSessionKey(label: string, env: NodeJS.ProcessEnv = process.env): string {
  const key = `${slugify(label)}-${randomBytes(4).toString("hex")}`;
  const socket = cliSocketPathFor(sessionPaths(key, env).runtimeDir);
  const bytes = Buffer.byteLength(socket, "utf8");
  if (bytes > MAX_SOCKET_PATH_BYTES) {
    throw new UobError(
      "INVALID_ARGUMENT",
      `Session label "${label}" produces a ${bytes}-byte CLI socket path, over the ${MAX_SOCKET_PATH_BYTES}-byte limit.`,
      {
        remediation:
          "Unix socket paths are capped at 108 bytes. Use a shorter label, or set KNAP_HOME to a " +
          "shorter directory than the default ~/.knapper_mcp.",
        details: { label, socket, bytes },
      },
    );
  }
  return key;
}
