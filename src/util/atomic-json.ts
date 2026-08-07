import { randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";

export interface AtomicJsonOptions {
  mode?: number;
  directoryMode?: number;
}

export type AtomicFileContent = string | Uint8Array;

/** Replace a file only after the complete new content reaches disk. */
export async function writeFileAtomic(
  path: string,
  content: AtomicFileContent,
  opts: AtomicJsonOptions = {},
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, {
    recursive: true,
    ...(opts.directoryMode !== undefined ? { mode: opts.directoryMode } : {}),
  });

  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(tmp, "wx", opts.mode ?? 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(tmp, path);

    // Persist the directory entry as well as the file contents. Some filesystems
    // can otherwise lose the rename after a power failure.
    try {
      const directoryHandle = await open(directory, "r");
      try {
        await directoryHandle.sync();
      } finally {
        await directoryHandle.close();
      }
    } catch {
      // The rename already completed. Some filesystems do not support directory
      // fsync, so a durability enhancement must not turn a successful write into
      // a reported failure.
    }
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}

/** Replace a JSON file only after the complete new value reaches disk. */
export async function writeJsonAtomic(
  path: string,
  value: unknown,
  opts: AtomicJsonOptions = {},
): Promise<void> {
  await writeFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`, opts);
}
