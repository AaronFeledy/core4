/**
 * Giving root-owned Lando files back to the user, as a planned host change. The bounded scan finds
 * the top-most root-owned entries; the change runs Lando's own race-safe walker as root
 * (`__internal:repair-root-ownership`), which opens every entry relative to a pinned parent,
 * changes ownership on the opened descriptor, never follows symlinks, skips hard links, devices,
 * other filesystems, and provider storage contents, and refuses before changing anything when a
 * root or its ancestors are unsafe.
 *
 * Planning decides what Lando can give back before anything asks: only Linux and WSL offer the
 * change, and only for entries under a root the walker accepts that are not hard links. Every
 * other entry (a hard link, an entry under a root the walker would refuse, any entry elsewhere)
 * stays manual with its own command, and a hard link's command removes the link instead of giving
 * it away. After the walker runs, `remaining` is what is still root-owned: what the walker left on
 * purpose or could not finish, then what a fresh scan finds.
 */
import { posix } from "node:path";

import {
  type RootOwnedEntry,
  type RootOwnershipScan,
  hardLinkEntry,
  ownedEntry,
  scanRootOwnership,
  unfinishedEntry,
  unreadableNameEntry,
} from "@lando/engine/host/root-ownership";
import { repairArgv } from "@lando/engine/host/root-ownership-repair-cli";
import { HostChangeFailedError } from "@lando/sdk/errors";
import { type HostChange, HostChangeId } from "@lando/sdk/schema";
import { FileSystem, type HostChangeProposal, type LandoPaths } from "@lando/sdk/services";
import { Effect, Ref, Schema } from "effect";

export const REPAIR_ROOT_OWNERSHIP = HostChangeId.make("core:repair-root-ownership");
const REPAIR_STEP = "repair";

export interface RootOwnershipRepairInput {
  /** The run's resolved paths; nothing here re-reads configuration. */
  readonly paths: Pick<LandoPaths, "roots" | "runtimeStorageDir" | "pluginsDir" | "binDir">;
  readonly uid: number;
  readonly gid: number;
  readonly user: string;
  readonly platform: string;
  /** The invoking user's home directory, which the walker never treats as a root. */
  readonly home: string | undefined;
  /** How to run this Lando again: the compiled binary, or bun and the entry script. */
  readonly invocation: ReadonlyArray<string>;
}

export interface RootOwnershipRepairPlan {
  readonly scan: RootOwnershipScan;
  /** Present when Lando can give some entries back itself. */
  readonly proposal?: HostChangeProposal;
  /** Entries Lando gives back. */
  readonly repairable: ReadonlyArray<RootOwnedEntry>;
  /** Entries only the user can fix, each with its exact command. */
  readonly manual: ReadonlyArray<RootOwnedEntry>;
  /**
   * What is still root-owned after the repair ran: what the walker left on purpose or could not
   * finish, then what a fresh scan finds, with the scan's own gaps.
   */
  readonly remaining: Effect.Effect<RootOwnershipScan, never, FileSystem>;
}

const inside = (parent: string, path: string): boolean => path === parent || path.startsWith(`${parent}/`);

const WalkerSkip = Schema.Struct({ path: Schema.String, reason: Schema.String });
const WalkerReport = Schema.Union([
  Schema.Struct({ refused: Schema.String }),
  Schema.Struct({
    changed: Schema.Number,
    skipped: Schema.Array(WalkerSkip),
    incomplete: Schema.Array(Schema.String),
  }),
]);
const decodeReport = Schema.decodeUnknownOption(Schema.fromJsonString(WalkerReport));

interface Leftovers {
  readonly skipped: ReadonlyArray<typeof WalkerSkip.Type>;
  readonly incomplete: ReadonlyArray<string>;
}

/** The walker's own name for a path it could not read; the entry to fix is its directory. */
const UNREADABLE_NAME = "/<non-utf8>";

/**
 * An entry the walker left as it was, with what fixes it by hand. The walker reports only entries
 * the previous owner still holds, so a special file or mount point gets a `chown` of itself alone;
 * a hard link's directory is the user's once the walker has been there. Symlinks are never changed
 * and block nothing, and provider storage is the runtime's, so neither is left over. Nothing the
 * walker did not confirm gets a `chown`: an entry that changed while it worked is unfinished.
 */
const skippedEntry = (
  skip: typeof WalkerSkip.Type,
  ids: { readonly uid: number; readonly gid: number; readonly storage: string },
): RootOwnedEntry | undefined => {
  switch (skip.reason) {
    case "hard-link":
      return hardLinkEntry(skip.path, { inRootOwnedDirectory: false });
    case "special-file":
      return ownedEntry(skip.path, {
        ...ids,
        recursive: false,
        note: "a special file, which Lando does not change",
      });
    case "cross-filesystem":
      return ownedEntry(skip.path, {
        ...ids,
        recursive: false,
        note: "on another filesystem, which Lando does not cross",
      });
    case "invalid-name":
      return unreadableNameEntry(skip.path.slice(0, -UNREADABLE_NAME.length), ids);
    case "changed-during-repair":
      return unfinishedEntry(skip.path);
    default:
      return undefined;
  }
};

/**
 * Whether the walker would accept `root`: an existing absolute directory other than `/` and the
 * home directory, reached through directories owned by root or the user that no one else can
 * write (unless sticky), and whose parent the user owns. A missing root has nothing to repair, and
 * the walker refuses a request naming one, so it is never passed.
 */
const rootVerdict = Effect.fnUntraced(function* (root: string, uid: number, home: string | undefined) {
  if (!posix.isAbsolute(root) || posix.normalize(root) !== root || root === "/" || root === home)
    return "refused" as const;
  const fs = yield* FileSystem;
  const parts = root.split("/").slice(1);
  let path = "/";
  for (const [index, name] of ["", ...parts].entries()) {
    path = index === 0 ? "/" : posix.join(path, name);
    const isRoot = index === parts.length;
    const stat = yield* fs.lstat(path).pipe(Effect.option);
    if (stat._tag === "None") return isRoot ? ("missing" as const) : ("refused" as const);
    const { isDirectory, isSymbolicLink, uid: owner, mode } = stat.value;
    if (!isDirectory || isSymbolicLink === true || owner === undefined || mode === undefined)
      return "refused" as const;
    if (owner !== 0 && owner !== uid) return "refused" as const;
    if ((mode & 0o022) !== 0 && (mode & 0o1000) === 0) return "refused" as const;
    if (index === parts.length - 1 && owner !== uid) return "refused" as const;
  }
  return "accepted" as const;
});

/** The top-most of `paths`, once each: the walker descends into each one by itself. */
const topMost = (paths: ReadonlyArray<string>): ReadonlyArray<string> => {
  const unique = [...new Set(paths.map((path) => posix.normalize(path)))];
  return unique.filter((path) => !unique.some((other) => other !== path && inside(other, path)));
};

const failure = (
  message: string,
  remediation: string,
  extra: { readonly exitCode?: number; readonly stderr?: string } = {},
) =>
  new HostChangeFailedError({
    changeId: REPAIR_ROOT_OWNERSHIP,
    stepId: REPAIR_STEP,
    message,
    remediation,
    ...extra,
  });

/** One line per entry: the command, and why it is that command when that is not obvious. */
export const rootOwnedManualCommands = (entries: ReadonlyArray<RootOwnedEntry>): string =>
  entries.map(({ remediation }) => remediation).join("\n");

export const planRootOwnershipRepair = Effect.fn("RootOwnership.planRepair")(function* (
  input: RootOwnershipRepairInput,
) {
  const scanNow = scanRootOwnership({ paths: input.paths, uid: input.uid, gid: input.gid });
  const scan = yield* scanNow;
  const { roots, runtimeStorageDir: storage } = input.paths;
  const ids = { uid: input.uid, gid: input.gid, storage };
  const leftovers = yield* Ref.make<Leftovers>({ skipped: [], incomplete: [] });
  const remaining = Effect.gen(function* () {
    const walked = yield* Ref.get(leftovers);
    const fresh = yield* scanNow;
    const byPath = new Map<string, RootOwnedEntry>();
    for (const skip of walked.skipped) {
      const entry = skippedEntry(skip, ids);
      if (entry !== undefined && !byPath.has(entry.path)) byPath.set(entry.path, entry);
    }
    // A path the walker did not finish may well be the user's already; rerunning is the fix.
    for (const path of walked.incomplete) if (!byPath.has(path)) byPath.set(path, unfinishedEntry(path));
    for (const entry of fresh.rootOwned) if (!byPath.has(entry.path)) byPath.set(entry.path, entry);
    return { rootOwned: [...byPath.values()], incomplete: fresh.incomplete } satisfies RootOwnershipScan;
  });
  const none = { scan, repairable: [], manual: scan.rootOwned, remaining } satisfies RootOwnershipRepairPlan;
  if (scan.rootOwned.length === 0 || input.platform !== "linux" || input.home === undefined) return none;
  const dataRoot = roots.userDataRoot;
  // Storage is named relative to the data root, so the data root anchors any repair it is in.
  if (storage === dataRoot || !inside(dataRoot, storage)) return none;
  const candidates = [...new Set([dataRoot, roots.userConfRoot, roots.userCacheRoot])];
  const verdicts = new Map<string, "accepted" | "missing" | "refused">();
  for (const root of candidates) verdicts.set(root, yield* rootVerdict(root, input.uid, input.home));
  if (verdicts.get(dataRoot) === "refused") return none;
  const dataRootExists = verdicts.get(dataRoot) === "accepted";
  const rootOf = (path: string) => candidates.find((root) => inside(root, path));
  const repairable = scan.rootOwned.filter(({ path, kind }) => {
    const root = rootOf(path);
    return kind === "owned" && root !== undefined && verdicts.get(root) === "accepted";
  });
  const manual = scan.rootOwned.filter((entry) => !repairable.includes(entry));
  if (repairable.length === 0)
    return { scan, repairable, manual, remaining } satisfies RootOwnershipRepairPlan;

  // Only roots that exist, each once; the data root, with its storage, only when it exists.
  const usedRoots = [
    ...(dataRootExists ? [dataRoot] : []),
    ...candidates.filter((root) => root !== dataRoot && repairable.some(({ path }) => rootOf(path) === root)),
  ];
  const argv = repairArgv({
    invocation: input.invocation,
    uid: input.uid,
    gid: input.gid,
    roots: usedRoots,
    ...(dataRootExists ? { storage } : {}),
    paths: topMost(repairable.map(({ path }) => path)),
  });
  const [program, ...rest] = argv;
  if (program === undefined) return none;
  const count = repairable.length;
  const change: HostChange = {
    id: REPAIR_ROOT_OWNERSHIP,
    owner: "@lando/core",
    stage: "lando-roots",
    summary: `Give ${count} root-owned Lando path${count === 1 ? "" : "s"} back to ${input.user}`,
    reason:
      "Lando's files include some owned by root, usually left by running lando with sudo, so Lando cannot write them. Lando's own walker gives them back without following symlinks, crossing filesystems, changing hard links, or changing the container runtime's storage contents.",
    consent: "standard",
    persistent: false,
    requirement: "required",
    details: { paths: repairable.map(({ path }) => path).join("\n") },
    steps: [
      {
        id: REPAIR_STEP,
        summary: "Give the listed paths and their contents back to you",
        argv: [program, ...rest],
        privileged: true,
        when: "always",
      },
    ],
    manual: repairable.map(({ command }) => command).join(" && "),
    undo: { _tag: "none", detail: "Ownership returns to you; there is nothing to undo." },
  };
  const fs = yield* FileSystem;
  const manualRemediation = `Give them back yourself:\n${rootOwnedManualCommands(repairable)}`;
  const proposal: HostChangeProposal = {
    change,
    apply: Effect.fnUntraced(function* (steps) {
      const fresh = yield* scanNow.pipe(Effect.provideService(FileSystem, fs));
      if (!fresh.rootOwned.some(({ path }) => repairable.some((entry) => entry.path === path))) {
        return { changed: false };
      }
      const result = yield* steps.run(REPAIR_STEP);
      const report = decodeReport(result.stdout.split("\n")[0] ?? "");
      if (report._tag === "None") {
        return yield* Effect.fail(
          failure(
            `Lando's ownership repair exited ${result.exitCode} without a report${result.stderr.trim().length === 0 ? "" : `: ${result.stderr.trim()}`}.`,
            manualRemediation,
            { exitCode: result.exitCode, stderr: result.stderr },
          ),
        );
      }
      const value = report.value;
      if ("refused" in value) {
        return yield* Effect.fail(
          failure(
            `Lando's ownership repair refused to change anything (${value.refused}).`,
            manualRemediation,
            {
              exitCode: result.exitCode,
            },
          ),
        );
      }
      yield* Ref.set(leftovers, { skipped: value.skipped, incomplete: value.incomplete });
      const skipped = value.skipped.map(({ path, reason }) => `${path} (${reason})`).join(", ");
      return {
        changed: value.changed > 0,
        facts: {
          changed: String(value.changed),
          ...(skipped.length === 0 ? {} : { skipped }),
          ...(value.incomplete.length === 0 ? {} : { incomplete: value.incomplete.join(", ") }),
        },
      };
    }),
  };
  return { scan, proposal, repairable, manual, remaining } satisfies RootOwnershipRepairPlan;
});

/** Setup and doctor share these words for what remains root-owned. */
export const remainingRootOwnedMessage = (count: number): string =>
  `Lando's files include ${count} owned by root, usually left by running lando with sudo, so Lando cannot write them.`;
