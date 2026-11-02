import { join } from "node:path";
import type { LandofileShape } from "@lando/sdk/schema";
import type { StateStoreShape } from "@lando/sdk/services";
import { Effect } from "effect";
import { copyLandofileProvenance } from "./copy-provenance.ts";
import {
  type LandofileIncludeDeps,
  type ResolveContext,
  type ResolveIncludesError,
  resolveCacheRoot,
} from "./include-context.ts";
import { includeError } from "./include-guard.ts";
import { includeAcquisitionView } from "./include-layer-overlays.ts";
import { inspectIncludeComposition } from "./include-load-stage.ts";
import { byCodepointString, parseLockEntries, writeLockEntries } from "./include-lockfile.ts";
import { loadIncludePins } from "./include-pins.ts";
import {
  authoredIncludeEntries,
  authoredIncludeEntriesWithPaths,
  normalizeInclude,
} from "./include-source.ts";
import { resolveTree } from "./include-tree.ts";
import type { PresentLandofileLayer } from "./layers.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "./load-expression-file.ts";
import { createLoadFailureRecorder, finishLoadStage } from "./load-failures.ts";
import type { LandofileLoadScope } from "./pipeline/materialize.ts";
import { getOrigins, rememberOrigins } from "./pipeline/origins.ts";
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
  readonly validate?: Effect.Effect<void, ResolveIncludesError>;
  readonly layers?: readonly {
    readonly layer: PresentLandofileLayer;
    readonly landofile: Record<string, unknown>;
  }[];
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
  const recorder = options.loadScope.recorder ?? createLoadFailureRecorder();
  const pins = yield* loadIncludePins({
    pins: parseLockEntries(options.stateStore, options.appRoot, lockfilePath),
    lockfile: lockfilePath,
    recorder,
  });
  const existing = pins.entries;
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
    recorder,
    pendingSites: options.loadScope.pendingSites,
    lockAvailable: pins.available,
    appRoot: options.appRoot,
    sourceRoot: options.appRoot,
    userOwned: false,
    cacheRoot: yield* resolveCacheRoot(options.cacheRoot, options.ports),
    lockfilePath,
    deps: options.deps ?? {},
    maxDepth: options.maxDepth ?? 8,
    mode: "refresh",
    lockEntries: existing,
    loadScope: { ...options.loadScope, includeMode: "all" },
    stagedLocks: new Map(),
    walk: { selectors: new Map(), issues: new Map(), complete: true },
    noNetwork,
    loadPolicy: DEFAULT_LANDOFILE_LOAD_POLICY,
    ...(options.ports === undefined ? {} : { ports: options.ports }),
  };
  const resolved = [];
  for (const item of options.layers ?? [
    {
      landofile,
      layer: {
        filePath: join(options.appRoot, ".lando.yml"),
        layer: "canonical" as const,
        order: 3 as const,
      },
    },
  ]) {
    let selected = item.landofile;
    if (scoped && options.layers !== undefined) {
      const entries = authoredIncludeEntriesWithPaths(includeAcquisitionView(item.landofile)).filter(
        ({ entry }) => requested.has(normalizeInclude(entry).source),
      );
      const { include: _include, includes: _includes, ...rest } = item.landofile;
      selected = copyLandofileProvenance(item.landofile, {
        ...rest,
        includes: entries.map(({ entry }) => entry),
      });
      const origins = getOrigins(item.landofile);
      const includesOrigin = origins?.children.get("includes") ?? origins?.children.get("include");
      if (origins !== undefined && includesOrigin !== undefined) {
        const children = new Map(origins.children);
        children.set("includes", {
          ...includesOrigin,
          children: new Map(
            entries.flatMap(({ path }, index) => {
              const node = origins.children.get(path[0] ?? "")?.children.get(path[1] ?? "");
              return node === undefined ? [] : [[index, node] as const];
            }),
          ),
        });
        rememberOrigins(selected, { ...origins, children });
      }
    }
    resolved.push(
      yield* resolveTree(selected, ctx, {
        depth: 0,
        stack: [options.appRoot],
        source: item.layer.filePath,
        layer: item.layer.layer,
        order: item.layer.order,
      }),
    );
  }
  yield* inspectIncludeComposition(resolved, {
    appRoot: options.appRoot,
    scope: { ...options.loadScope, includeMode: "all" },
    recorder,
  });
  yield* finishLoadStage(join(options.appRoot, ".lando.yml"), recorder);
  yield* Effect.forEach(recorder.effectiveChecks, (check) => check);
  if (options.validate !== undefined) yield* options.validate;
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
