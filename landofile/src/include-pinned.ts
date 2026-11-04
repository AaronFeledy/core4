import { dirname, join } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import { LandofileLockMismatchError } from "@lando/sdk/errors";
import type { SourceKey, SourceSnapshot } from "@lando/source-acquisition";
import { displaySource } from "@lando/source-acquisition";
import {
  type FragmentResult,
  LOCK_REMEDIATION,
  NO_NETWORK_REMEDIATION,
  type NormalizedInclude,
  type ResolveContext,
} from "./include-context.ts";
import { hasIncludeCycle } from "./include-graph.ts";
import { assertUnderRoot, includeError } from "./include-guard.ts";
import { readText } from "./include-local.ts";
import { lockValue } from "./include-lockfile.ts";
import { reserveIncludeSelector, selectorLabel } from "./include-selector.ts";

// A resolved revision becomes a lock identity and physical store key.
export const RESOLVED_FORMAT = {
  git: { pattern: /^[a-f0-9]{40}$/u, label: "40 lowercase hex commit SHA" },
  npm: {
    pattern: /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u,
    label: "exact npm package version",
  },
} as const;

export type RemoteFragmentResult = FragmentResult & {
  readonly snapshotRoot: string;
  readonly key: SourceKey;
};

export interface RemoteFragmentLayout {
  readonly sourceId: string;
  readonly version: string | undefined;
  readonly cacheKind: "git" | "npm";
  readonly fragmentRelPath: string;
  /** Open a warm physical entry for the locked revision (no network). */
  readonly openCached: (resolved: string) => Promise<SourceSnapshot | undefined>;
  /**
   * Network acquisition. `resolved` is set for cold pin rematerialize (exact
   * pin); undefined for first pin or refresh. `repair` is true for online refresh.
   */
  readonly acquire: (
    resolved: string | undefined,
    options: { readonly repair: boolean },
  ) => Promise<SourceSnapshot>;
}

const resolvedIdentity = (snapshot: SourceSnapshot, cacheKind: "git" | "npm", fallback?: string): string => {
  switch (cacheKind) {
    case "git":
      switch (snapshot.key.kind) {
        case "git":
          return snapshot.key.commit;
        case "archive":
          return fallback ?? "";
        default: {
          const exhaustive: never = snapshot.key;
          return exhaustive;
        }
      }
    case "npm":
      switch (snapshot.pin.kind) {
        case "npm":
          return snapshot.pin.version;
        case "archive":
        case "git":
          return fallback ?? "";
        default: {
          const exhaustive: never = snapshot.pin;
          return exhaustive;
        }
      }
    default: {
      const exhaustive: never = cacheKind;
      return exhaustive;
    }
  }
};

const fragmentFromSnapshot = async (
  entry: NormalizedInclude,
  layout: RemoteFragmentLayout,
  observation: { readonly snapshot: SourceSnapshot; readonly resolved: string },
): Promise<RemoteFragmentResult> => {
  const { snapshot, resolved } = observation;
  const contentRoot = layout.cacheKind === "npm" ? join(snapshot.root, "package") : snapshot.root;
  const filePath = await assertUnderRoot(
    contentRoot,
    join(contentRoot, layout.fragmentRelPath),
    entry.source,
    "remote source",
  );
  const content = await readText(filePath, entry.source);
  return {
    sourceId: layout.sourceId,
    inventoryId: layout.sourceId,
    authoredSource: entry.source,
    resolved,
    ...(layout.version === undefined ? {} : { version: layout.version }),
    content,
    filePath,
    root: dirname(filePath),
    snapshotRoot: contentRoot,
    key: snapshot.key,
    userOwned: false,
    locked: true,
  };
};

// One pinned-read path for loads, verify, and offline updates.
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
  reserveIncludeSelector(ctx.walk.selectors, { sourceId, version });
  const proposed = ctx.mode === "pin" ? ctx.stagedLocks.get(sourceId) : undefined;
  const locked = proposed ?? ctx.lockEntries.get(sourceId);
  const mismatch = (expected: string, actual: string, observed: "requested" | "found" = "requested") =>
    new LandofileLockMismatchError({
      message: displaySource(
        `Landofile include lock mismatch for ${sourceId}: locked ${expected}, ${observed} ${actual}.`,
      ),
      lockfile: ctx.lockfilePath,
      source: displaySource(sourceId),
      expected: displaySource(expected),
      actual: displaySource(actual),
      remediation: LOCK_REMEDIATION,
    });

  // Online refresh always fetches authoritative bytes with repair.
  if (ctx.mode === "refresh" && !ctx.noNetwork) {
    const snapshot = await layout.acquire(undefined, { repair: true });
    const resolved = resolvedIdentity(snapshot, layout.cacheKind, layout.version);
    if (!RESOLVED_FORMAT[layout.cacheKind].pattern.test(resolved))
      throw includeError({
        message: `Include ${entry.source} resolved to an invalid ${layout.cacheKind} identity: ${resolved}.`,
        source: entry.source,
        kind: "fetch-failed",
      });
    return fragmentFromSnapshot(entry, layout, { snapshot, resolved });
  }

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
    const snapshot = await layout.acquire(undefined, { repair: false });
    const resolved = resolvedIdentity(snapshot, layout.cacheKind, layout.version);
    if (!RESOLVED_FORMAT[layout.cacheKind].pattern.test(resolved))
      throw includeError({
        message: `Include ${entry.source} resolved to an invalid ${layout.cacheKind} identity: ${resolved}.`,
        source: entry.source,
        kind: "fetch-failed",
      });
    return fragmentFromSnapshot(entry, layout, { snapshot, resolved });
  }

  try {
    if (!RESOLVED_FORMAT[layout.cacheKind].pattern.test(locked.resolved))
      throw mismatch(RESOLVED_FORMAT[layout.cacheKind].label, locked.resolved, "found");

    let snapshot = await layout.openCached(locked.resolved);
    if (snapshot === undefined) {
      if (ctx.noNetwork)
        throw includeError({
          message: `--no-network: cached fragment for ${entry.source} at requested selector ${selectorLabel(version)} is missing.`,
          source: entry.source,
          kind: "fetch-failed",
          remediation: NO_NETWORK_REMEDIATION,
        });
      snapshot = await layout.acquire(locked.resolved, { repair: false });
    }

    // Physical keys identify the entry; lock.resolved is the include identity
    // (git commit or npm version). Archive pins for npm do not carry the version.
    const resolved = locked.resolved;
    if (layout.cacheKind === "git" && snapshot.key.kind === "git" && snapshot.key.commit !== locked.resolved)
      throw mismatch(lockValue(locked), snapshot.key.commit, "found");
    if (layout.cacheKind === "npm" && snapshot.pin.kind === "npm" && snapshot.pin.version !== locked.resolved)
      throw mismatch(lockValue(locked), snapshot.pin.version, "found");

    const fragment = await fragmentFromSnapshot(entry, layout, { snapshot, resolved });
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
