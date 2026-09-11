import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { syncDirectory } from "@lando/state-store/atomic";
import { type OwnerOnlyFileAccess, enforceOwnerOnlyFileAccess } from "@lando/state-store/private-file-access";
import { transactionError } from "./transaction-error.ts";

export interface PrivateFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface CreatePrivateFileOptions {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly privateFileAccess?: OwnerOnlyFileAccess;
  readonly record?: (identity: PrivateFileIdentity) => void;
  readonly statMaybe: (
    path: string,
  ) => Promise<Awaited<ReturnType<typeof import("node:fs/promises").lstat>> | null>;
}

const removeCreatedFile = async (
  path: string,
  identity: PrivateFileIdentity,
  statMaybe: CreatePrivateFileOptions["statMaybe"],
): Promise<void> => {
  const current = await statMaybe(path);
  if (
    current?.isFile() &&
    !current.isSymbolicLink() &&
    current.dev === identity.dev &&
    current.ino === identity.ino
  ) {
    await unlink(path);
  }
};

export const createPrivateFile = async (options: CreatePrivateFileOptions): Promise<void> => {
  const handle = await open(options.path, "wx", 0o600);
  const identity = await handle.stat();
  options.record?.(identity);
  try {
    try {
      await handle.chmod(0o600);
      await (options.privateFileAccess ?? enforceOwnerOnlyFileAccess)(options.path);
      await handle.writeFile(options.bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (cause) {
    await removeCreatedFile(options.path, identity, options.statMaybe);
    throw cause;
  }
  await syncDirectory(dirname(options.path));
};

export const hasCode = (cause: unknown, code: string): boolean =>
  cause instanceof Error && "code" in cause && cause.code === code;

export const statMaybe = async (path: string) => {
  try {
    return await lstat(path);
  } catch (cause) {
    if (hasCode(cause, "ENOENT")) return null;
    throw cause;
  }
};

export const ensureDirectory = async (path: string): Promise<void> => {
  const parent = dirname(path);
  if (parent !== path) await ensureDirectory(parent);
  const stats = await statMaybe(path);
  if (stats !== null) {
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw transactionError("path", "prepare", path);
    return;
  }
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (cause) {
    if (!hasCode(cause, "EEXIST")) throw cause;
  }
  const created = await lstat(path);
  if (!created.isDirectory() || created.isSymbolicLink()) throw transactionError("path", "prepare", path);
  await syncDirectory(dirname(path));
};

export const canonicalRoot = async (path: string): Promise<string> => {
  const root = await realpath(path);
  if (!(await lstat(root)).isDirectory()) throw transactionError("path", "prepare");
  return root;
};

export const targetPath = async (root: string, path: string): Promise<string> => {
  const target = resolve(root, path);
  const rel = relative(root, target);
  if (isAbsolute(path) || rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw transactionError("path", "prepare", path);
  }
  if ((await realpath(root)) !== root) throw transactionError("path", "prepare", path);
  let parent = dirname(target);
  while (parent !== root) {
    const stats = await lstat(parent);
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw transactionError("path", "prepare", path);
    parent = dirname(parent);
  }
  const stats = await statMaybe(target);
  if (stats !== null && (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1)) {
    throw transactionError("path", "prepare", path);
  }
  return target;
};
