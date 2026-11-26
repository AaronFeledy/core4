/**
 * Lando's race-safe walker that gives root-owned entries under its roots back to the invoking
 * user, run as root by `__internal:repair-root-ownership` (`root-ownership-repair-cli.ts`). It
 * admits a request only from sudo for the same user, pins each root through descriptors from `/`,
 * opens every entry relative to its pinned parent, and changes ownership on the opened
 * descriptor. It never follows a symlink, crosses a filesystem, enters provider storage, or
 * changes a hard link, special file, or entry that changed while it worked; those it reports.
 */
import * as fs from "node:fs";

const PROC_FD = "/proc/self/fd";
const PROC_SUPER_MAGIC = 0x9fa0;
const O_PATH = 0x200000;
const { O_RDONLY, O_NOFOLLOW, O_NONBLOCK, O_NOCTTY, O_DIRECTORY } = fs.constants;
const OPEN_FLAGS = O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY;
const MAX_DEPTH = 64;
const MAX_ENTRIES = 200_000;
const MAX_MS = 60_000;

export interface RepairRequest {
  readonly uid: number;
  readonly gid: number;
  /** With storage, the data root first; every root authorizes targets, and each one must exist. */
  readonly roots: readonly string[];
  /** The data root's provider storage; absent when the request leaves the data root out. */
  readonly storage?: string;
  readonly paths: readonly string[];
}

export type Refusal = { readonly refused: string };
type Skip = { readonly path: string; readonly reason: string };
export type RepairReport =
  | Refusal
  | {
      readonly changed: number;
      /**
       * Entries the walker left as they are, at most 20: ones still owned by the previous owner (a
       * hard link, special file, symlink, or another filesystem), names it cannot read, entries
       * that changed while it worked, and provider storage it does not enter.
       */
      readonly skipped: readonly Skip[];
      readonly incomplete: readonly string[];
    };

export interface RepairHost {
  readonly euid: number | undefined;
  readonly env: { readonly SUDO_UID?: string | undefined; readonly SUDO_GID?: string | undefined };
  readonly fromUid?: number;
  readonly platform: string;
  readonly now: () => number;
  readonly homeOf: (uid: number) => string | undefined;
  readonly lstatSync: (path: string) => fs.BigIntStats;
  readonly fstatSync: (fd: number) => fs.BigIntStats;
  readonly statfsSync: (path: string) => { readonly type: number };
  readonly readdirSync: (path: string) => readonly Buffer[];
  readonly openSync: (path: string, flags: number) => number;
  readonly closeSync: (fd: number) => void;
  readonly fchownSync: (fd: number, uid: number, gid: number) => void;
}

export const validId = (id: number): boolean => Number.isInteger(id) && id > 0 && id < 0xffffffff;
export const parseId = (text: string | undefined): number =>
  text !== undefined && /^\d+$/u.test(text) ? Number(text) : Number.NaN;
export const refused = (reason: string): Refusal => ({ refused: reason });

const canonicalPath = (path: string): boolean =>
  path === "/" ||
  (path.startsWith("/") &&
    !path.includes("\0") &&
    path
      .slice(1)
      .split("/")
      .every((part) => part !== "" && part !== "." && part !== ".."));
const inside = (parent: string, path: string): boolean => path.startsWith(`${parent}/`);
const sameInode = (a: fs.BigIntStats, b: fs.BigIntStats): boolean => a.dev === b.dev && a.ino === b.ino;
const fdPath = (fd: number): string => `${PROC_FD}/${fd}`;
const errno = (error: unknown): unknown =>
  error instanceof Error && "code" in error ? error.code : undefined;

interface Pinned {
  readonly fd: number;
  readonly stat: fs.BigIntStats;
}

const supportsDescriptors = (host: RepairHost): boolean => {
  if (host.platform !== "linux") return false;
  try {
    if (host.statfsSync(PROC_FD).type !== PROC_SUPER_MAGIC) return false;
    const fd = host.openSync(PROC_FD, OPEN_FLAGS | O_DIRECTORY);
    try {
      // Use a child lookup through the magic fd link, not just a stat of the link itself.
      const throughProc = host.openSync(`${fdPath(fd)}/.`, OPEN_FLAGS | O_DIRECTORY);
      try {
        return sameInode(host.fstatSync(fd), host.fstatSync(throughProc));
      } finally {
        host.closeSync(throughProc);
      }
    } finally {
      host.closeSync(fd);
    }
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
};

const pin = (host: RepairHost, path: string, before: fs.BigIntStats): Pinned | string => {
  const directory = before.isDirectory();
  if (!directory && !before.isFile()) return before.isSymbolicLink() ? "symlink" : "special-file";
  let fd: number;
  try {
    // An lstat alone cannot prevent opening a device substituted for a regular file.
    fd = host.openSync(path, directory ? OPEN_FLAGS | O_DIRECTORY : O_PATH | O_NOFOLLOW);
  } catch (error) {
    const code = errno(error);
    if (code === "ELOOP" || code === "ENOENT" || code === "ENOTDIR") return "changed-during-repair";
    throw error;
  }
  let keep = false;
  try {
    const stat = host.fstatSync(fd);
    if (!sameInode(before, stat) || (directory ? !stat.isDirectory() : !stat.isFile()))
      return "changed-during-repair";
    if (directory) {
      keep = true;
      return { fd, stat };
    }
    // Follow only our own kernel fd link, never a second lookup of the entry's name.
    const writableOwner = host.openSync(fdPath(fd), OPEN_FLAGS & ~O_NOFOLLOW);
    let keepOwner = false;
    try {
      const current = host.fstatSync(writableOwner);
      if (!sameInode(stat, current) || !current.isFile()) return "changed-during-repair";
      keepOwner = true;
      return { fd: writableOwner, stat: current };
    } finally {
      if (!keepOwner) host.closeSync(writableOwner);
    }
  } finally {
    if (!keep) host.closeSync(fd);
  }
};

const pinRoot = (host: RepairHost, root: string, uid: bigint): Pinned | Refusal => {
  let parent: Pinned | undefined;
  try {
    let path = "/";
    const parts = ["", ...root.slice(1).split("/")];
    for (const [index, name] of parts.entries()) {
      const isRoot = index === parts.length - 1;
      if (isRoot && parent?.stat.uid !== uid) return refused("root-parent-not-user-owned");
      path = parent === undefined ? "/" : `${fdPath(parent.fd)}/${name}`;
      const stat = host.lstatSync(path);
      if (!stat.isDirectory()) return refused("root-component-not-directory");
      const opened = pin(host, path, stat);
      if (typeof opened === "string") return refused(opened);
      const previous = parent;
      parent = opened;
      if (previous !== undefined) host.closeSync(previous.fd);
      const { mode, uid: owner } = opened.stat;
      if (owner !== 0n && owner !== uid) return refused("root-component-foreign-owner");
      if ((mode & 0o022n) !== 0n && (mode & 0o1000n) === 0n) return refused("root-component-writable");
    }
    if (parent === undefined) return refused("invalid-root");
    const result = parent;
    parent = undefined;
    return result;
  } catch (error) {
    if (error instanceof Error) return refused("root-unavailable");
    throw error;
  } finally {
    if (parent !== undefined) host.closeSync(parent.fd);
  }
};

// Pin storage from the data root, keeping the inode live even if its name changes.
const pinStorage = (host: RepairHost, data: Pinned, relative: string): Pinned | undefined | Refusal => {
  let parent = data;
  try {
    for (const name of relative.split("/")) {
      const path = `${fdPath(parent.fd)}/${name}`;
      const stat = host.lstatSync(path);
      if (!stat.isDirectory()) return refused("storage-not-directory");
      const opened = pin(host, path, stat);
      if (typeof opened === "string") return refused(opened);
      const previous = parent;
      parent = opened;
      if (previous !== data) host.closeSync(previous.fd);
    }
    const result = parent;
    parent = data;
    return result;
  } catch (error) {
    if (errno(error) === "ENOENT") return undefined;
    if (error instanceof Error) return refused("storage-unavailable");
    throw error;
  } finally {
    if (parent !== data) host.closeSync(parent.fd);
  }
};

interface Visit {
  readonly path: string;
  readonly depth: number;
  readonly remaining: readonly string[];
  readonly device: bigint;
}

export const repairRootOwnership = (request: RepairRequest, host: RepairHost): RepairReport => {
  const { uid, gid, roots, paths, storage } = request;
  if (host.euid !== 0) return refused("not-root");
  if (
    !validId(uid) ||
    !validId(gid) ||
    parseId(host.env.SUDO_UID) !== uid ||
    parseId(host.env.SUDO_GID) !== gid
  )
    return refused("sudo-identity-mismatch");
  if (!supportsDescriptors(host)) return refused("unsupported-platform");
  let home: string | undefined;
  try {
    home = host.homeOf(uid);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return refused("invoking-home-unavailable");
  }
  if (home === undefined || !canonicalPath(home)) return refused("invoking-home-unavailable");
  if (roots.some((root) => !canonicalPath(root) || root === "/" || root === home))
    return refused("invalid-root");
  const [dataRoot] = roots;
  if (
    storage !== undefined &&
    (dataRoot === undefined || !canonicalPath(storage) || !inside(dataRoot, storage))
  )
    return refused("storage-outside-data-root");
  if (
    paths.length === 0 ||
    paths.some((path) => !canonicalPath(path) || !roots.some((root) => root === path || inside(root, path)))
  )
    return refused("path-outside-roots");

  const deadline = host.now() + MAX_MS;
  const pinned = new Map<string, Pinned>();
  let storagePin: Pinned | undefined;
  try {
    for (const root of roots) {
      if (pinned.has(root)) continue;
      const directory = pinRoot(host, root, BigInt(uid));
      if ("refused" in directory) return directory;
      pinned.set(root, directory);
    }
    if (storage !== undefined && dataRoot !== undefined) {
      const data = pinned.get(dataRoot);
      if (data === undefined) return refused("invalid-root");
      const located = pinStorage(host, data, storage.slice(dataRoot.length + 1));
      if (located !== undefined && "refused" in located) return located;
      storagePin = located;
    }
    const from = BigInt(host.fromUid ?? 0);
    const skipped: Skip[] = [];
    const incomplete = new Set<string>();
    let changed = 0;
    let seen = 0;
    let exhausted = false;

    const skip = (path: string, reason: string): void => {
      if (skipped.length < 20) skipped.push({ path, reason });
    };
    const stop = (path: string): false => {
      exhausted = true;
      incomplete.add(path);
      return false;
    };
    const withinBudget = (visit: Visit): boolean => {
      if (seen >= MAX_ENTRIES || host.now() >= deadline) return stop(visit.path);
      if (visit.depth > MAX_DEPTH) {
        incomplete.add(visit.path);
        return false;
      }
      seen += 1;
      return true;
    };
    const visitPinned = (entry: Pinned, visit: Visit): void => {
      const { fd, stat } = entry;
      const { path, remaining } = visit;
      if (host.now() >= deadline) {
        stop(path);
        return;
      }
      const [next, ...tail] = remaining;
      const isStorage = path === storage || (storagePin !== undefined && sameInode(stat, storagePin.stat));
      if ((storage !== undefined && inside(storage, path)) || (isStorage && next !== undefined)) {
        skip(path, "provider-storage");
        return;
      }
      if (next !== undefined) {
        if (stat.isDirectory()) visitChild(fd, next, { ...visit, remaining: tail });
        else incomplete.add(path);
        return;
      }
      if (stat.uid === from) {
        if (stat.isFile() && stat.nlink > 1n) skip(path, "hard-link");
        else {
          host.fchownSync(fd, uid, gid);
          changed += 1;
        }
      }
      if (!stat.isDirectory() || isStorage) return;
      const children = host.readdirSync(fdPath(fd));
      if (visit.depth === MAX_DEPTH) {
        if (children.length > 0) incomplete.add(path);
        return;
      }
      for (const raw of children) {
        const name = raw.toString("utf8");
        if (!raw.equals(Buffer.from(name))) {
          if (!withinBudget({ ...visit, depth: visit.depth + 1 })) break;
          skip(`${path}/<non-utf8>`, "invalid-name");
          continue;
        }
        visitChild(fd, name, visit);
        if (exhausted) {
          incomplete.add(path);
          break;
        }
      }
    };
    const visitChild = (parent: number, name: string, ancestor: Visit): void => {
      const path = `${ancestor.path}/${name}`;
      const visit = { ...ancestor, path, depth: ancestor.depth + 1 };
      if (!withinBudget(visit)) return;
      try {
        const lookup = `${fdPath(parent)}/${name}`;
        const stat = host.lstatSync(lookup);
        // An entry another owner holds was never the walker's to change, so it is not reported.
        const candidate = stat.uid === from || visit.remaining.length > 0;
        if (stat.dev !== visit.device) {
          if (candidate) skip(path, "cross-filesystem");
          return;
        }
        const entry = pin(host, lookup, stat);
        if (typeof entry === "string") {
          if (candidate || entry === "changed-during-repair") skip(path, entry);
          if (entry === "changed-during-repair" || visit.remaining.length > 0) incomplete.add(path);
          return;
        }
        try {
          visitPinned(entry, visit);
        } finally {
          host.closeSync(entry.fd);
        }
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        incomplete.add(path);
      }
    };
    for (const path of paths) {
      if (exhausted) {
        incomplete.add(path);
        continue;
      }
      // Use the outermost authorized root so a nested root never bypasses a storage or device stop.
      const root = roots
        .filter((candidate) => candidate === path || inside(candidate, path))
        .reduce((outer, candidate) => (candidate.length < outer.length ? candidate : outer), path);
      const directory = pinned.get(root);
      if (directory === undefined) {
        incomplete.add(path);
        continue;
      }
      const remaining = root === path ? [] : path.slice(root.length + 1).split("/");
      const visit = { path: root, depth: 0, remaining, device: directory.stat.dev };
      if (!withinBudget(visit)) {
        incomplete.add(path);
        continue;
      }
      try {
        visitPinned(directory, visit);
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        incomplete.add(root);
      }
    }
    return { changed, skipped, incomplete: [...incomplete] };
  } finally {
    if (storagePin !== undefined) host.closeSync(storagePin.fd);
    for (const { fd } of pinned.values()) host.closeSync(fd);
  }
};
