import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { knapperHome } from "../config.js";
import { writeFileAtomic, writeJsonAtomic } from "../util/atomic-json.js";
import { UobError } from "../util/errors.js";
import { withFileLock } from "../util/filelock.js";

interface FileBackup {
  existed: boolean;
  mode?: number;
}

interface FileSnapshot {
  backup: FileBackup;
  content?: Buffer;
}

interface DirectoryIdentity {
  path: string;
  device: string;
  inode: string;
}

interface RollbackDirectory {
  path: string;
  ancestor: DirectoryIdentity;
  identity?: DirectoryIdentity;
}

interface VaultTransactionJournal {
  schema: 1;
  id: string;
  operation: "create" | "unregister";
  state: "prepared" | "committed";
  phase: string;
  startedAt: string;
  obsidianPath: string;
  authorizationPath: string;
  obsidianBackup: FileBackup;
  authorizationBackup: FileBackup;
  rollbackDirectory?: RollbackDirectory;
}

export interface VaultTransactionControl {
  checkpoint: (phase: string) => Promise<void>;
  recordCreatedDirectory: (path: string) => Promise<void>;
}

export interface VaultTransactionOptions {
  env: NodeJS.ProcessEnv;
  configPath: string;
  authorizationPath: string;
  operation: VaultTransactionJournal["operation"];
  rollbackDirectory?: string | (() => string | undefined);
  validate?: () => void | Promise<void>;
  fault?: (phase: string) => void | Promise<void>;
}

const JOURNAL_SCHEMA = 1;

function transactionRoot(env: NodeJS.ProcessEnv): string {
  return join(knapperHome(env), "vault-transactions");
}

function journalPath(env: NodeJS.ProcessEnv): string {
  return join(transactionRoot(env), "current.json");
}

function lifecycleLockPath(env: NodeJS.ProcessEnv): string {
  return join(knapperHome(env), "vault-lifecycle.lock");
}

function transactionDirectory(env: NodeJS.ProcessEnv, id: string): string {
  return join(transactionRoot(env), id);
}

function backupPath(
  env: NodeJS.ProcessEnv,
  id: string,
  name: "obsidian" | "authorization",
): string {
  return join(transactionDirectory(env, id), `${name}.backup`);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFileBackup(value: unknown): value is FileBackup {
  if (!isObject(value) || typeof value.existed !== "boolean") return false;
  return (
    value.mode === undefined || (typeof value.mode === "number" && Number.isInteger(value.mode))
  );
}

function isDirectoryIdentity(value: unknown): value is DirectoryIdentity {
  return (
    isObject(value) &&
    typeof value.path === "string" &&
    typeof value.device === "string" &&
    typeof value.inode === "string"
  );
}

function parseJournal(value: unknown): VaultTransactionJournal | undefined {
  if (!isObject(value)) return undefined;
  if (
    value.schema !== JOURNAL_SCHEMA ||
    typeof value.id !== "string" ||
    (value.operation !== "create" && value.operation !== "unregister") ||
    (value.state !== "prepared" && value.state !== "committed") ||
    typeof value.phase !== "string" ||
    typeof value.startedAt !== "string" ||
    typeof value.obsidianPath !== "string" ||
    typeof value.authorizationPath !== "string" ||
    !isFileBackup(value.obsidianBackup) ||
    !isFileBackup(value.authorizationBackup)
  ) {
    return undefined;
  }

  let rollbackDirectory: RollbackDirectory | undefined;
  if (value.rollbackDirectory !== undefined) {
    if (
      !isObject(value.rollbackDirectory) ||
      typeof value.rollbackDirectory.path !== "string" ||
      !isDirectoryIdentity(value.rollbackDirectory.ancestor) ||
      (value.rollbackDirectory.identity !== undefined &&
        !isDirectoryIdentity(value.rollbackDirectory.identity))
    ) {
      return undefined;
    }
    rollbackDirectory = {
      path: value.rollbackDirectory.path,
      ancestor: value.rollbackDirectory.ancestor,
      ...(value.rollbackDirectory.identity !== undefined
        ? { identity: value.rollbackDirectory.identity }
        : {}),
    };
  }

  return {
    schema: JOURNAL_SCHEMA,
    id: value.id,
    operation: value.operation,
    state: value.state,
    phase: value.phase,
    startedAt: value.startedAt,
    obsidianPath: value.obsidianPath,
    authorizationPath: value.authorizationPath,
    obsidianBackup: value.obsidianBackup,
    authorizationBackup: value.authorizationBackup,
    ...(rollbackDirectory !== undefined ? { rollbackDirectory } : {}),
  };
}

async function identity(path: string): Promise<DirectoryIdentity> {
  const canonical = await realpath(path);
  const info = await stat(canonical, { bigint: true });
  if (!info.isDirectory()) throw new Error(`${canonical} is not a directory.`);
  return { path: canonical, device: info.dev.toString(), inode: info.ino.toString() };
}

async function nearestExistingAncestor(path: string): Promise<DirectoryIdentity> {
  let candidate = dirname(path);
  for (;;) {
    try {
      const ancestor = await identity(candidate);
      if (ancestor.path !== resolve(candidate)) {
        throw new Error(`The path ${path} uses a symbolic-link ancestor.`);
      }
      return ancestor;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function snapshotFile(source: string): Promise<FileSnapshot> {
  try {
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink() || (await realpath(source)) !== resolve(source)) {
      throw new Error(`${source} is not a direct regular file.`);
    }
    return { backup: { existed: true, mode: info.mode & 0o777 }, content: await readFile(source) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      await nearestExistingAncestor(source);
      return { backup: { existed: false } };
    }
    throw error;
  }
}

async function persistBackup(snapshot: FileSnapshot, destination: string): Promise<void> {
  if (snapshot.content === undefined) return;
  await writeFileAtomic(destination, snapshot.content, {
    mode: 0o600,
    directoryMode: 0o700,
  });
}

async function restoreFile(target: string, backup: FileBackup, backupFile: string): Promise<void> {
  if (!backup.existed) {
    await rm(target, { force: true });
    return;
  }
  await writeFileAtomic(target, await readFile(backupFile), { mode: backup.mode ?? 0o600 });
}

function sameIdentity(first: DirectoryIdentity, second: DirectoryIdentity): boolean {
  return (
    first.path === second.path && first.device === second.device && first.inode === second.inode
  );
}

function assertExpectedJournal(
  journal: VaultTransactionJournal,
  opts: Pick<VaultTransactionOptions, "env" | "configPath" | "authorizationPath">,
): void {
  if (
    !isAbsolute(journal.obsidianPath) ||
    !isAbsolute(journal.authorizationPath) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(journal.id)
  ) {
    throw new Error("The transaction journal contains an invalid path or identifier.");
  }
  if (
    resolve(journal.obsidianPath) !== resolve(opts.configPath) ||
    resolve(journal.authorizationPath) !== resolve(opts.authorizationPath)
  ) {
    throw new Error("The transaction registry paths do not match this lifecycle operation.");
  }

  const directory = resolve(transactionDirectory(opts.env, journal.id));
  const root = resolve(transactionRoot(opts.env));
  if (relative(root, directory).startsWith(`..${sep}`) || directory === root) {
    throw new Error("The transaction backup path is outside the transaction directory.");
  }
  if (journal.rollbackDirectory !== undefined) {
    const rollback = journal.rollbackDirectory;
    const rollbackRelative = relative(rollback.ancestor.path, rollback.path);
    if (
      !isAbsolute(rollback.path) ||
      !isAbsolute(rollback.ancestor.path) ||
      rollbackRelative === "" ||
      rollbackRelative === ".." ||
      rollbackRelative.startsWith(`..${sep}`) ||
      isAbsolute(rollbackRelative)
    ) {
      throw new Error("The transaction rollback path is invalid.");
    }
  }
}

async function quarantineCreatedDirectory(
  journal: VaultTransactionJournal,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const rollback = journal.rollbackDirectory;
  if (rollback === undefined) return;

  let targetInfo;
  try {
    targetInfo = await lstat(rollback.path, { bigint: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!targetInfo.isDirectory() || targetInfo.isSymbolicLink()) {
    throw new Error(`The rollback path ${rollback.path} is not the created directory.`);
  }

  const ancestorNow = await identity(rollback.ancestor.path);
  if (!sameIdentity(ancestorNow, rollback.ancestor)) {
    throw new Error(`The rollback ancestor for ${rollback.path} changed.`);
  }

  if (rollback.identity !== undefined) {
    const targetNow = await identity(rollback.path);
    if (!sameIdentity(targetNow, rollback.identity)) {
      throw new Error(`The rollback directory identity for ${rollback.path} changed.`);
    }
  } else if ((await readdir(rollback.path)).length > 0) {
    // No identity means the process stopped between mkdir and the journal update.
    // Only an empty directory is safe to quarantine in that state.
    throw new Error(`The unverified rollback directory ${rollback.path} is not empty.`);
  }

  const trash = join(knapperHome(env), "trash");
  await mkdir(trash, { recursive: true, mode: 0o700 });
  const destination = join(
    trash,
    `vault-rollback-${Date.now()}-${journal.id}-${basename(rollback.path)}`,
  );
  await rename(rollback.path, destination);
}

async function removeTransactionFiles(journal: VaultTransactionJournal, env: NodeJS.ProcessEnv) {
  await rm(journalPath(env), { force: true });
  await rm(transactionDirectory(env, journal.id), { recursive: true, force: true });
}

async function rollback(journal: VaultTransactionJournal, env: NodeJS.ProcessEnv): Promise<void> {
  assertExpectedJournal(journal, {
    env,
    configPath: journal.obsidianPath,
    authorizationPath: journal.authorizationPath,
  });
  const failures: string[] = [];
  for (const restore of [
    () =>
      restoreFile(
        journal.obsidianPath,
        journal.obsidianBackup,
        backupPath(env, journal.id, "obsidian"),
      ),
    () =>
      restoreFile(
        journal.authorizationPath,
        journal.authorizationBackup,
        backupPath(env, journal.id, "authorization"),
      ),
    () => quarantineCreatedDirectory(journal, env),
  ]) {
    try {
      await restore();
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (failures.length > 0) {
    throw new Error(`Vault transaction rollback failed: ${failures.join(" ")}`);
  }
  await removeTransactionFiles(journal, env);
}

async function readCurrentJournal(
  opts: Pick<VaultTransactionOptions, "env" | "configPath" | "authorizationPath">,
): Promise<VaultTransactionJournal | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(journalPath(opts.env), "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const journal = parseJournal(value);
  if (journal === undefined) throw new Error("The vault transaction journal is invalid.");
  assertExpectedJournal(journal, opts);
  return journal;
}

async function recoverCurrentTransactionUnlocked(
  opts: Pick<VaultTransactionOptions, "env" | "configPath" | "authorizationPath">,
): Promise<void> {
  const journal = await readCurrentJournal(opts);
  if (journal === undefined) return;
  if (journal.state === "committed") {
    await removeTransactionFiles(journal, opts.env);
    return;
  }
  await rollback(journal, opts.env);
}

/** Recover an interrupted vault transaction before another lifecycle write starts. */
export async function recoverVaultTransaction(
  configPath: string,
  authorizationPath: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  await withFileLock(lifecycleLockPath(env), () =>
    recoverCurrentTransactionUnlocked({ env, configPath, authorizationPath }),
  );
}

/** Run registry changes with durable backups and one lifecycle lock. */
export async function withVaultTransaction<T>(
  opts: VaultTransactionOptions,
  work: (control: VaultTransactionControl) => Promise<T>,
): Promise<T> {
  return withFileLock(lifecycleLockPath(opts.env), async () => {
    await recoverCurrentTransactionUnlocked(opts);
    await opts.validate?.();

    const id = randomUUID();
    const obsidianSnapshot = await snapshotFile(opts.configPath);
    const authorizationSnapshot = await snapshotFile(opts.authorizationPath);
    await nearestExistingAncestor(transactionRoot(opts.env));
    let rollbackDirectory: RollbackDirectory | undefined;
    const requestedRollbackDirectory =
      typeof opts.rollbackDirectory === "function"
        ? opts.rollbackDirectory()
        : opts.rollbackDirectory;
    if (requestedRollbackDirectory !== undefined) {
      const path = resolve(requestedRollbackDirectory);
      rollbackDirectory = { path, ancestor: await nearestExistingAncestor(path) };
    }
    await persistBackup(obsidianSnapshot, backupPath(opts.env, id, "obsidian"));
    await persistBackup(authorizationSnapshot, backupPath(opts.env, id, "authorization"));
    const obsidianBackup = obsidianSnapshot.backup;
    const authorizationBackup = authorizationSnapshot.backup;
    let journal: VaultTransactionJournal = {
      schema: JOURNAL_SCHEMA,
      id,
      operation: opts.operation,
      state: "prepared",
      phase: "journaled",
      startedAt: new Date().toISOString(),
      obsidianPath: resolve(opts.configPath),
      authorizationPath: resolve(opts.authorizationPath),
      obsidianBackup,
      authorizationBackup,
      ...(rollbackDirectory !== undefined ? { rollbackDirectory } : {}),
    };
    await writeJsonAtomic(journalPath(opts.env), journal, {
      mode: 0o600,
      directoryMode: 0o700,
    });

    const checkpoint = async (phase: string): Promise<void> => {
      journal = { ...journal, phase };
      await writeJsonAtomic(journalPath(opts.env), journal, {
        mode: 0o600,
        directoryMode: 0o700,
      });
      await opts.fault?.(phase);
    };

    try {
      await opts.fault?.("journaled");
      const result = await work({
        checkpoint,
        recordCreatedDirectory: async (path) => {
          if (journal.rollbackDirectory === undefined) {
            throw new Error("This transaction has no rollback directory.");
          }
          const canonical = resolve(path);
          if (canonical !== journal.rollbackDirectory.path) {
            throw new Error("The created directory does not match the rollback path.");
          }
          journal = {
            ...journal,
            rollbackDirectory: {
              ...journal.rollbackDirectory,
              identity: await identity(canonical),
            },
          };
          await checkpoint("directory-created");
        },
      });
      await opts.fault?.("before-commit");
      journal = { ...journal, state: "committed", phase: "committed" };
      await writeJsonAtomic(journalPath(opts.env), journal, {
        mode: 0o600,
        directoryMode: 0o700,
      });
      // A committed journal is safe to recover as cleanup-only if this removal
      // fails. Do not roll back committed registry changes.
      await removeTransactionFiles(journal, opts.env).catch(() => undefined);
      return result;
    } catch (error) {
      try {
        await rollback(journal, opts.env);
      } catch (rollbackError) {
        throw new UobError("INTERNAL", "The vault lifecycle transaction could not roll back.", {
          remediation:
            "Keep the transaction journal and backups. Repair the reported path before the next vault lifecycle change.",
          details: {
            cause: error instanceof Error ? error.message : String(error),
            rollback:
              rollbackError instanceof Error ? rollbackError.message : String(rollbackError),
            journal: journalPath(opts.env),
          },
        });
      }
      throw error;
    }
  });
}

/** Serialize an authorization-only change after any vault transaction. */
export async function withVaultLifecycleLock<T>(
  env: NodeJS.ProcessEnv,
  work: () => Promise<T>,
  recovery?: { configPath: string; authorizationPath: string },
): Promise<T> {
  return withFileLock(lifecycleLockPath(env), async () => {
    if (recovery !== undefined) {
      await recoverCurrentTransactionUnlocked({ env, ...recovery });
    }
    return work();
  });
}
