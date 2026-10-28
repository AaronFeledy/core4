import { join } from "node:path";
import type { LandofileShape } from "@lando/sdk/schema";
import type { StateStoreShape } from "@lando/sdk/services";
import { Effect } from "effect";
import {
  type LandofileIncludeDeps,
  type ResolveContext,
  type ResolveIncludesError,
  resolveCacheRoot,
} from "./include-context.ts";
import { includeError } from "./include-guard.ts";
import { byCodepointString, parseLockEntries, writeLockEntries } from "./include-lockfile.ts";
import { authoredIncludeEntries, normalizeInclude } from "./include-source.ts";
import { resolveTree } from "./include-tree.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "./load-expression-file.ts";
import type { LandofileLoadScope } from "./pipeline/materialize.ts";
import type { LandofileRuntimePorts } from "./ports.ts";

export type IncludeUpdateStatus = "added" | "updated" | "unchanged";
export interface IncludeUpdateEntry {
  readonly source: string;
  readonly version?: string;
  readonly resolved: string;
  readonly checksum: string;
  readonly status: IncludeUpdateStatus;
}
export interface IncludeUpdateReport {
  readonly lockfilePath: string;
  readonly entries: ReadonlyArray<IncludeUpdateEntry>;
  readonly removed: ReadonlyArray<string>;
  readonly drift: boolean;
  readonly wrote: boolean;
  readonly checkMode: boolean;
  readonly noNetwork: boolean;
  readonly requestedSources: ReadonlyArray<string>;
}
export interface UpdateLandofileIncludesOptions {
  readonly loadScope: LandofileLoadScope;
  readonly landofile: LandofileShape;
  readonly appRoot: string;
  readonly cacheRoot?: string;
  readonly lockfilePath?: string;
  readonly deps?: LandofileIncludeDeps;
  readonly maxDepth?: number;
  readonly check?: boolean;
  readonly sources?: ReadonlyArray<string>;
  readonly noNetwork?: boolean;
  readonly ports?: LandofileRuntimePorts;
  readonly stateStore?: StateStoreShape;
}
export const updateLandofileIncludes = Effect.fn("Landofile.updateIncludes")(function* (
  options: UpdateLandofileIncludesOptions,
): Effect.fn.Return<IncludeUpdateReport, ResolveIncludesError> {
  const lockfilePath = options.lockfilePath ?? join(options.appRoot, ".lando.lock.yml");
  const checkMode = options.check === true;
  const noNetwork = options.noNetwork === true;
  const requestedSources = options.sources ?? [];
  const scoped = requestedSources.length > 0;
  const existing = yield* parseLockEntries(options.stateStore, options.appRoot, lockfilePath);
  const allIncludes = authoredIncludeEntries(options.landofile);
  if (scoped) {
    const known = new Set(allIncludes.map((entry) => normalizeInclude(entry).source));
    const unknown = requestedSources.filter((source) => !known.has(source));
    if (unknown.length > 0) {
      const knownList = [...known].sort(byCodepointString).join(", ") || "(none)";
      return yield* Effect.fail(
        includeError({
          message: `Unknown include source${unknown.length === 1 ? "" : "s"} ${unknown.join(", ")}. Known sources: ${knownList}.`,
          source: unknown.join(", "),
          kind: "source-unresolved",
          remediation:
            "Pass a known include source, or run lando app:includes:update with no source to refresh every include.",
        }),
      );
    }
  }
  const requested = new Set(requestedSources);
  const includes = scoped
    ? allIncludes.filter((entry) => requested.has(normalizeInclude(entry).source))
    : allIncludes;
  const { include: _include, ...landofileWithoutComposeIncludes } = options.landofile;
  const landofile: LandofileShape = scoped
    ? { ...landofileWithoutComposeIncludes, includes }
    : options.landofile;
  const ctx: ResolveContext = {
    appRoot: options.appRoot,
    sourceRoot: options.appRoot,
    userOwned: false,
    cacheRoot: yield* resolveCacheRoot(options.cacheRoot, options.ports),
    lockfilePath,
    deps: options.deps ?? {},
    maxDepth: options.maxDepth ?? 8,
    mode: "refresh",
    lockEntries: existing,
    loadScope: options.loadScope,
    stagedLocks: new Map(),
    walk: { selectors: new Map(), issues: new Map(), complete: true },
    noNetwork,
    loadPolicy: DEFAULT_LANDOFILE_LOAD_POLICY,
    ...(options.ports === undefined ? {} : { ports: options.ports }),
  };
  if (includes.length > 0)
    yield* resolveTree(
      landofile,
      ctx,
      0,
      [options.appRoot],
      join(options.appRoot, ".lando.yml"),
      "canonical",
      3,
    );
  const entries: IncludeUpdateEntry[] = [...ctx.stagedLocks.values()]
    .sort((left, right) => byCodepointString(left.source, right.source))
    .map((entry) => {
      const prev = existing.get(entry.source);
      const status: IncludeUpdateStatus =
        prev === undefined
          ? "added"
          : prev.version !== entry.version ||
              prev.resolved !== entry.resolved ||
              prev.checksum !== entry.checksum
            ? "updated"
            : "unchanged";
      return { ...entry, status };
    });
  const removed = scoped
    ? []
    : [...existing.keys()].filter((source) => !ctx.stagedLocks.has(source)).sort(byCodepointString);
  const drift = entries.some((entry) => entry.status !== "unchanged") || removed.length > 0;
  let wrote = false;
  if (!checkMode && drift) {
    yield* writeLockEntries(options.stateStore, {
      appRoot: options.appRoot,
      lockfilePath,
      entries: [...ctx.stagedLocks.values()],
      merge: scoped,
    });
    wrote = true;
  }
  return { lockfilePath, entries, removed, drift, wrote, checkMode, noNetwork, requestedSources };
});
