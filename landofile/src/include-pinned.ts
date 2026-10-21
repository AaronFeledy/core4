import { dirname, join } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import { LandofileLockMismatchError } from "@lando/sdk/errors";
import {
  type FragmentResult,
  LOCK_REMEDIATION,
  NO_NETWORK_REMEDIATION,
  type NormalizedInclude,
  type ResolveContext,
} from "./include-context.ts";
import { hasIncludeCycle } from "./include-graph.ts";
import { assertUnderRoot, includeError, realpathOrSelf } from "./include-guard.ts";
import { fileExists, readText } from "./include-local.ts";
import { lockValue } from "./include-lockfile.ts";

// A resolved revision becomes a cache directory name and, for git, a fetch ref.
export const RESOLVED_FORMAT = {
  git: { pattern: /^[a-f0-9]{40}$/u, label: "40 lowercase hex commit SHA" },
  npm: {
    pattern: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    label: "exact npm package version",
  },
} as const;

// An include without version: or @ref follows the remote default.
const selectorLabel = (selector: string | undefined): string => selector ?? "<default>";

export type RemoteFragmentResult = FragmentResult & { readonly snapshotRoot: string };

export interface RemoteFragmentLayout {
  readonly sourceId: string;
  readonly version: string | undefined;
  readonly cacheKind: "git" | "npm";
  readonly publishedDirName: (resolved: string) => string;
  readonly fragmentRelPath: string;
  readonly snapshotSubdir: "" | "package";
  readonly acquire: (resolved: string | undefined) => Promise<RemoteFragmentResult>;
}

// One pinned-read path for loads, verify, and offline updates. The callback is
// network-only and always returns an observation from fresh staging bytes.
export const readPinnedFragment = async (
  entry: NormalizedInclude,
  ctx: ResolveContext,
  layout: RemoteFragmentLayout,
): Promise<RemoteFragmentResult | undefined> => {
  const { sourceId, version } = layout;
  if (hasIncludeCycle(ctx.ancestors ?? [], sourceId))
    throw includeError({
      message: `Landofile include cycle detected at ${entry.source}.`,
      source: entry.source,
      kind: "cycle",
    });
  if (ctx.walk.selectors.has(sourceId) && ctx.walk.selectors.get(sourceId) !== version)
    throw includeError({
      message: `Conflicting selectors for ${sourceId}: ${selectorLabel(ctx.walk.selectors.get(sourceId))} and ${selectorLabel(version)}.`,
      source: sourceId,
      kind: "source-unresolved",
      remediation: "Include each remote fragment at one version.",
    });
  ctx.walk.selectors.set(sourceId, version);
  const locked = ctx.lockEntries.get(sourceId);
  const mismatch = (expected: string, actual: string, observed: "requested" | "found" = "requested") =>
    new LandofileLockMismatchError({
      message: `Landofile include lock mismatch for ${sourceId}: locked ${expected}, ${observed} ${actual}.`,
      lockfile: ctx.lockfilePath,
      source: sourceId,
      expected,
      actual,
      remediation: LOCK_REMEDIATION,
    });
  if (ctx.mode === "refresh" && !ctx.noNetwork) return layout.acquire(undefined);
  if (locked === undefined || locked.version !== version) {
    if (ctx.noNetwork)
      throw includeError({
        message: `--no-network: no matching pinned cache for ${entry.source} at requested selector ${selectorLabel(version)}.`,
        source: entry.source,
        kind: "source-unresolved",
        remediation: NO_NETWORK_REMEDIATION,
      });
    if (ctx.mode === "verify") {
      ctx.walk.issues.set(sourceId, {
        status: locked === undefined ? "missing" : "mismatch",
        expected: locked === undefined ? null : selectorLabel(locked.version),
        actual: selectorLabel(version),
      });
      ctx.walk.complete = false;
      return undefined;
    }
    return layout.acquire(undefined);
  }
  try {
    if (!RESOLVED_FORMAT[layout.cacheKind].pattern.test(locked.resolved))
      throw mismatch(RESOLVED_FORMAT[layout.cacheKind].label, locked.resolved, "found");
    // Resolve the root first: a not-yet-cached revision has no realpath, and the
    // guard compares a missing path lexically against the resolved root.
    const cacheRoot = await realpathOrSelf(join(ctx.cacheRoot, "includes", layout.cacheKind));
    const publishedDir = await assertUnderRoot(
      cacheRoot,
      join(cacheRoot, layout.publishedDirName(locked.resolved)),
      entry.source,
      "include cache",
    );
    const filePath = await assertUnderRoot(
      publishedDir,
      join(publishedDir, layout.fragmentRelPath),
      entry.source,
      "remote source",
    );
    const snapshotRoot = await assertUnderRoot(
      publishedDir,
      join(publishedDir, layout.snapshotSubdir),
      entry.source,
      "remote source",
    );
    let fragment: RemoteFragmentResult;
    if (await fileExists(filePath)) {
      fragment = {
        sourceId,
        inventoryId: sourceId,
        authoredSource: entry.source,
        resolved: locked.resolved,
        ...(version === undefined ? {} : { version }),
        content: await readText(filePath, entry.source),
        filePath,
        root: dirname(filePath),
        snapshotRoot,
        userOwned: false,
        locked: true,
      };
    } else {
      if (ctx.noNetwork)
        throw includeError({
          message: `--no-network: cached fragment for ${entry.source} at requested selector ${selectorLabel(version)} is missing at ${filePath}.`,
          source: entry.source,
          kind: "fetch-failed",
          remediation: NO_NETWORK_REMEDIATION,
        });
      fragment = await layout.acquire(locked.resolved);
    }
    if (fragment.resolved !== locked.resolved || sha256Hex(fragment.content) !== locked.checksum)
      throw mismatch(
        lockValue(locked),
        `${version === undefined ? "" : `${version}@`}${fragment.resolved}:${sha256Hex(fragment.content)}`,
        "found",
      );
    return fragment;
  } catch (cause) {
    if (!(cause instanceof LandofileLockMismatchError) || ctx.mode !== "verify") throw cause;
    ctx.walk.issues.set(sourceId, { status: "mismatch", expected: cause.expected, actual: cause.actual });
    ctx.walk.complete = false;
    return undefined;
  }
};
