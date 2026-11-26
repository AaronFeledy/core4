/**
 * Bounded check for root-owned entries under Lando's own roots, the usual after-effect of running
 * Lando with sudo. It inspects each root, the root's top-level entries, and the children of the
 * directories Lando writes first, and never walks provider storage. Lando does not repair what it
 * finds: a privileged second pathname lookup over a user-writable tree can be raced into changing
 * files outside it, so the user runs the listed commands.
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
  /** Manual fix for this entry, never recursive through provider storage. */
  readonly remediation: string;
}

export interface RootOwnershipScan {
  /** Top-most root-owned entries; their contents are not listed separately. */
  readonly rootOwned: ReadonlyArray<RootOwnedEntry>;
  /** Why the scan is not a complete answer (truncated or unreadable). Empty when complete. */
  readonly incomplete: ReadonlyArray<string>;
}

const DEFAULT_MAX_ENTRIES = 5_000;
const DEFAULT_BUDGET_MS = 2_000;

export const scanRootOwnership = Effect.fn("RootOwnership.scan")(function* (input: RootOwnershipScanInput) {
  const fs = yield* FileSystem;
  const rootOwned: RootOwnedEntry[] = [];
  const incomplete: string[] = [];
  if (input.uid === 0) return { rootOwned, incomplete } satisfies RootOwnershipScan;

  const { paths } = input;
  const { roots } = paths;
  const storage = paths.runtimeStorageDir;
  const descend = new Set([paths.pluginsDir, paths.binDir, join(roots.userDataRoot, "setup")]);
  const owner = `${input.uid}:${input.gid}`;
  const remediationFor = (path: string): string =>
    storage === path || storage.startsWith(`${path}/`)
      ? `sudo chown ${owner} ${quoteShellPath(path)}  # not recursive: it holds the container runtime's storage`
      : `sudo chown -R ${owner} ${quoteShellPath(path)}`;
  const maxEntries = input.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const deadline = (yield* Clock.currentTimeMillis) + (input.budgetMs ?? DEFAULT_BUDGET_MS);
  let seen = 0;

  const inspect = Effect.fnUntraced(function* (path: string) {
    seen += 1;
    const stat = yield* fs.lstat(path).pipe(
      Effect.map((value) => ({ _tag: "stat" as const, value })),
      Effect.catchTag("FileNotFoundError", () => Effect.succeed({ _tag: "missing" as const })),
      Effect.catch((error) => Effect.succeed({ _tag: "unreadable" as const, message: error.message })),
    );
    if (stat._tag === "missing") return false;
    if (stat._tag === "unreadable") {
      incomplete.push(`${path} could not be inspected: ${stat.message}`);
      return false;
    }
    if (stat.value.uid === 0) {
      rootOwned.push({ path, remediation: remediationFor(path) });
      return false;
    }
    return stat.value.isDirectory && stat.value.isSymbolicLink !== true;
  });

  const children = Effect.fnUntraced(function* (dir: string) {
    return yield* fs.readDir(dir).pipe(
      Effect.map((names) => names.map((name) => join(dir, name))),
      Effect.catch((error) => {
        incomplete.push(`${dir} could not be listed: ${error.message}`);
        return Effect.succeed<ReadonlyArray<string>>([]);
      }),
    );
  });

  const withinBudget = Effect.fnUntraced(function* () {
    if (seen >= maxEntries) {
      incomplete.push(`stopped after ${maxEntries} entries`);
      return false;
    }
    if ((yield* Clock.currentTimeMillis) > deadline) {
      incomplete.push("stopped at the time limit");
      return false;
    }
    return true;
  });

  scan: for (const root of [roots.userDataRoot, roots.userConfRoot, roots.userCacheRoot]) {
    if (!(yield* inspect(root))) continue;
    for (const entry of yield* children(root)) {
      if (!(yield* withinBudget())) break scan;
      if (!(yield* inspect(entry)) || !descend.has(entry)) continue;
      for (const child of yield* children(entry)) {
        if (!(yield* withinBudget())) break scan;
        yield* inspect(child);
      }
    }
  }
  return { rootOwned, incomplete } satisfies RootOwnershipScan;
});
