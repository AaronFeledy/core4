/**
 * Bounded check for root-owned entries under Lando's own roots, the usual after-effect of running
 * Lando with sudo. It inspects each root, the root's top-level entries, and the children of the
 * directories Lando writes first, and never walks provider storage. It reads entries with `lstat`,
 * so it never follows one. A root-owned symlink is not reported: Lando never follows or changes
 * one, and it blocks no write in a directory the user owns. The entries found are the targets of
 * the race-safe repair walker (`root-ownership-repair.ts`), which setup and `lando doctor --fix`
 * run after asking; each also carries the manual command.
 *
 * A manual command never gives away more than the scan saw. A regular file with more than one
 * link that the user does not own is a hard link, possibly to a file outside Lando's roots, so
 * giving it back would give that file away too: its command removes the link instead (`rm -f`,
 * with `sudo` only when its directory is root's). A root-owned directory gets a recursive `chown`
 * only when the scan read everything under it and found no such link and no provider storage;
 * otherwise it gets a `chown` of the directory alone, followed by the commands for what inside it
 * needs one, in an order a person can run them.
 */
import { join } from "node:path";

import { FileSystem, type LandoPaths } from "@lando/sdk/services";
import { Clock, Effect } from "effect";
import { quoteShellPath } from "../services/shell-quote";

export interface RootOwnershipScanInput {
  /** The run's resolved paths; the scan never re-reads configuration. */
  readonly paths: Pick<LandoPaths, "roots" | "runtimeStorageDir" | "pluginsDir" | "binDir">;
  /** The invoking user; uid 0 means Lando itself runs as root and nothing is reported. */
  readonly uid: number;
  readonly gid: number;
  readonly maxEntries?: number;
  readonly budgetMs?: number;
}

export interface RootOwnedEntry {
  readonly path: string;
  /**
   * `owned`: given back with `chown`. `hard-link`: a file with other names, which only removing
   * the link fixes safely. `unfinished`: Lando could not finish checking it, so it offers no
   * command that would change it.
   */
  readonly kind: "owned" | "hard-link" | "unfinished";
  /** The one command that fixes this entry by hand; never a `chown` for a hard link. */
  readonly command: string;
  /** The command with why it is that command when that is not obvious: what a person reads. */
  readonly remediation: string;
}

export const HARD_LINK_REMEDY =
  "This file is a hard link to a file outside Lando's files, so changing its owner would change that file too. Remove the link; Lando creates it again if it needs it:";

/** `rm -f`: a plain `rm` asks before removing a file the user cannot write, such as root's. */
export const hardLinkEntry = (
  path: string,
  input: { readonly inRootOwnedDirectory: boolean },
): RootOwnedEntry => {
  const command = `${input.inRootOwnedDirectory ? "sudo " : ""}rm -f ${quoteShellPath(path)}`;
  return { path, kind: "hard-link", command, remediation: `${HARD_LINK_REMEDY} \`${command}\`` };
};

export const UNFINISHED_REMEDY = "Lando could not finish checking this directory; rerun `lando setup`.";

/** An entry Lando could not finish checking: rerunning is the fix, never a blind `chown`. */
export const unfinishedEntry = (path: string): RootOwnedEntry => ({
  path,
  kind: "unfinished",
  command: "lando setup",
  remediation: `${quoteShellPath(path)}: ${UNFINISHED_REMEDY}`,
});

/** A directory holding a name Lando cannot read, so it left that entry as it was. */
export const unreadableNameEntry = (
  dir: string,
  owner: { readonly uid: number; readonly gid: number },
): RootOwnedEntry => {
  const command = `ls -lb ${quoteShellPath(dir)}`;
  return {
    path: dir,
    kind: "unfinished",
    command,
    remediation: `${quoteShellPath(dir)} holds an entry whose name Lando cannot read, so Lando left it as it was. Find it with \`${command}\`, then give that entry alone back with \`sudo chown ${owner.uid}:${owner.gid}\`.`,
  };
};

export interface RootOwnedEntryInput {
  readonly uid: number;
  readonly gid: number;
  /** The container runtime's storage, which a manual fix never changes recursively. */
  readonly storage: string;
  /** Only when everything under the entry was read and nothing there must keep its owner. */
  readonly recursive: boolean;
  /** Why the entry is listed, when it is not simply owned by root. */
  readonly note?: string;
}

/** A root-owned entry the user gives back with `chown`, never recursively through storage. */
export const ownedEntry = (path: string, input: RootOwnedEntryInput): RootOwnedEntry => {
  const owner = `${input.uid}:${input.gid}`;
  const holdsStorage = input.storage === path || input.storage.startsWith(`${path}/`);
  const recursive = input.recursive && !holdsStorage;
  const command = `sudo chown ${recursive ? "-R " : ""}${owner} ${quoteShellPath(path)}`;
  const note =
    input.note ?? (holdsStorage ? "not recursive: it holds the container runtime's storage" : undefined);
  return {
    path,
    kind: "owned",
    command,
    remediation: note === undefined ? command : `${command}  # ${note}`,
  };
};

export interface RootOwnershipScan {
  /**
   * Root-owned entries, each once, parents before what inside them needs its own command. A
   * directory given back recursively covers everything under it.
   */
  readonly rootOwned: ReadonlyArray<RootOwnedEntry>;
  /** Why the scan is not a complete answer (truncated or unreadable). Empty when complete. */
  readonly incomplete: ReadonlyArray<string>;
}

const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_BUDGET_MS = 2_000;

/** Everything under a root-owned directory: whether one recursive `chown` is safe, and if not, the entries inside it to fix one by one. */
interface Subtree {
  readonly safe: boolean;
  readonly entries: ReadonlyArray<RootOwnedEntry>;
}

export const scanRootOwnership = Effect.fn("RootOwnership.scan")(function* (input: RootOwnershipScanInput) {
  const fs = yield* FileSystem;
  const found = new Map<string, RootOwnedEntry>();
  const incomplete: string[] = [];
  if (input.uid === 0) return { rootOwned: [], incomplete } satisfies RootOwnershipScan;

  const { paths } = input;
  const { roots } = paths;
  const storage = paths.runtimeStorageDir;
  const ids = { uid: input.uid, gid: input.gid, storage };
  const descend = new Set([paths.pluginsDir, paths.binDir, join(roots.userDataRoot, "setup")]);
  const maxEntries = input.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const deadline = (yield* Clock.currentTimeMillis) + (input.budgetMs ?? DEFAULT_BUDGET_MS);
  let seen = 0;
  let exhausted = false;
  const report = (entries: ReadonlyArray<RootOwnedEntry>) => {
    for (const entry of entries) if (!found.has(entry.path)) found.set(entry.path, entry);
  };

  const withinBudget = Effect.fnUntraced(function* () {
    if (exhausted) return false;
    if (seen >= maxEntries) incomplete.push(`stopped after ${maxEntries} entries`);
    else if ((yield* Clock.currentTimeMillis) > deadline) incomplete.push("stopped at the time limit");
    else {
      seen += 1;
      return true;
    }
    exhausted = true;
    return false;
  });

  const lstat = (path: string) =>
    fs.lstat(path).pipe(
      Effect.map((value) => ({ _tag: "stat" as const, value })),
      Effect.catchTag("FileNotFoundError", () => Effect.succeed({ _tag: "missing" as const })),
      Effect.catch((error) => {
        incomplete.push(`${path} could not be inspected: ${error.message}`);
        return Effect.succeed({ _tag: "unreadable" as const });
      }),
    );

  const children = (dir: string) =>
    fs.readDir(dir).pipe(
      Effect.map((names): ReadonlyArray<string> | undefined => names.map((name) => join(dir, name))),
      Effect.catch((error) => {
        incomplete.push(`${dir} could not be listed: ${error.message}`);
        return Effect.succeed(undefined);
      }),
    );

  const isHardLink = (stat: { readonly isFile: boolean; readonly nlink?: number; readonly uid?: number }) =>
    stat.isFile && (stat.nlink ?? 1) > 1 && stat.uid !== input.uid;

  /** Reads everything under `dir`, whose owner is root when `rootOwnedDir`. */
  const subtree: (dir: string, rootOwnedDir: boolean) => Effect.Effect<Subtree> = Effect.fnUntraced(
    function* (dir, rootOwnedDir) {
      const names = yield* children(dir);
      let safe = names !== undefined;
      const entries: RootOwnedEntry[] = [];
      for (const path of names ?? []) {
        if (!(yield* withinBudget())) {
          safe = false;
          break;
        }
        const stat = yield* lstat(path);
        if (stat._tag === "missing") continue;
        if (stat._tag === "unreadable") {
          safe = false;
          continue;
        }
        const { value } = stat;
        if (value.isSymbolicLink === true) continue;
        const rootOwned = value.uid === 0;
        if (path === storage) {
          // The runtime's storage is never walked or changed recursively.
          safe = false;
          if (rootOwned) entries.push(ownedEntry(path, { ...ids, recursive: false }));
          continue;
        }
        if (isHardLink(value)) {
          safe = false;
          if (rootOwned) entries.push(hardLinkEntry(path, { inRootOwnedDirectory: rootOwnedDir }));
          continue;
        }
        if (!value.isDirectory) {
          if (rootOwned) entries.push(ownedEntry(path, { ...ids, recursive: false }));
          continue;
        }
        const inside = yield* subtree(path, rootOwned);
        safe &&= inside.safe;
        if (rootOwned && inside.safe) entries.push(ownedEntry(path, { ...ids, recursive: true }));
        else if (rootOwned) entries.push(ownedEntry(path, { ...ids, recursive: false }), ...inside.entries);
        else entries.push(...inside.entries);
      }
      return { safe, entries };
    },
  );

  /**
   * One entry the scan reached, in a directory the user owns (a root-owned one is never looked
   * into here); true when the scan should look inside it.
   */
  const inspect = Effect.fnUntraced(function* (path: string) {
    const stat = yield* lstat(path);
    if (stat._tag !== "stat" || stat.value.isSymbolicLink === true) return false;
    const { value } = stat;
    if (value.uid !== 0) return value.isDirectory;
    if (isHardLink(value)) report([hardLinkEntry(path, { inRootOwnedDirectory: false })]);
    else if (!value.isDirectory || path === storage) report([ownedEntry(path, { ...ids, recursive: false })]);
    else {
      const inside = yield* subtree(path, true);
      report(
        inside.safe
          ? [ownedEntry(path, { ...ids, recursive: true })]
          : [ownedEntry(path, { ...ids, recursive: false }), ...inside.entries],
      );
    }
    return false;
  });

  scan: for (const root of [roots.userDataRoot, roots.userConfRoot, roots.userCacheRoot]) {
    seen += 1;
    if (!(yield* inspect(root))) continue;
    for (const entry of (yield* children(root)) ?? []) {
      if (!(yield* withinBudget())) break scan;
      if (!(yield* inspect(entry)) || !descend.has(entry)) continue;
      for (const child of (yield* children(entry)) ?? []) {
        if (!(yield* withinBudget())) break scan;
        yield* inspect(child);
      }
    }
  }
  return { rootOwned: [...found.values()], incomplete } satisfies RootOwnershipScan;
});
