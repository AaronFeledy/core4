import { join } from "node:path";
import { mergeLandofiles } from "@lando/sdk/landofile";
import type { LandofileDecodedOverlay, LandofileShape } from "@lando/sdk/schema";
import { Effect } from "effect";
import { rememberLandofileAppRoot } from "./app-root-provenance.ts";
import {
  type ResolveContext,
  type ResolveIncludesError,
  type ResolveLandofileIncludesOptions,
  resolveCacheRoot,
} from "./include-context.ts";
import { ownVersionConstraintEntries, withResolvedTooling } from "./include-fragment.ts";
import { getIncludeOverlays, includeAcquisitionView } from "./include-layer-overlays.ts";
import { parseLockEntries, writeLockfileIfNeeded } from "./include-lockfile.ts";
import {
  getLandofileIncludeSources,
  getLocalIncludePaths,
  rememberLandofileIncludeSources,
  rememberLocalIncludePaths,
} from "./include-provenance.ts";
import { authoredIncludeEntries, hasResolvableIncludes } from "./include-source.ts";
import { resolveTree } from "./include-tree.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "./load-expression-file.ts";
import {
  getLandofileReferencedFiles,
  rememberLandofileReferencedFiles,
} from "./load-expression-provenance.ts";
import {
  getInternalToolingTasks,
  rememberInternalToolingTasks,
  winningInternalToolingTasks,
} from "./tooling-include-provenance.ts";
import { resolveToolingIncludes } from "./tooling-includes.ts";
import { validateLandofile } from "./validation.ts";
import {
  type VersionConstraintEntry,
  getVersionConstraintEntries,
  rememberVersionConstraintEntries,
} from "./version-constraint.ts";

const authoredVersionConstraintEntries = (
  options: ResolveLandofileIncludesOptions,
  sourcePath: string,
): ReadonlyArray<VersionConstraintEntry> =>
  options.layer === undefined || options.order === undefined
    ? getVersionConstraintEntries(options.landofile, sourcePath)
    : ownVersionConstraintEntries(options.landofile, sourcePath, options.layer, options.order);

const resolveIncludes = Effect.fn("Landofile.resolveIncludes")(function* (
  options: ResolveLandofileIncludesOptions,
  retainLayers = false,
): Effect.fn.Return<LandofileShape, ResolveIncludesError> {
  if (!hasResolvableIncludes(includeAcquisitionView(options.landofile))) {
    const effective = retainLayers
      ? options.landofile
      : yield* validateLandofile(options.sourcePath ?? ".lando.yml", mergeLandofiles([options.landofile]));
    rememberLandofileIncludeSources(effective, getLandofileIncludeSources(options.landofile));
    rememberLocalIncludePaths(effective, getLocalIncludePaths(options.landofile));
    rememberLandofileReferencedFiles(effective, getLandofileReferencedFiles(options.landofile));
    return rememberLandofileAppRoot(
      rememberVersionConstraintEntries(
        effective,
        authoredVersionConstraintEntries(options, options.sourcePath ?? join(options.appRoot, ".lando.yml")),
      ),
      options.appRoot,
    );
  }
  const lockfilePath = options.lockfilePath ?? join(options.appRoot, ".lando.lock.yml");
  const ctx: ResolveContext = {
    loadScope: options.loadScope,
    appRoot: options.appRoot,
    sourceRoot: options.appRoot,
    userOwned: false,
    cacheRoot: yield* resolveCacheRoot(options.cacheRoot, options.ports),
    lockfilePath,
    deps: options.deps ?? {},
    maxDepth: options.maxDepth ?? 8,
    mode: "pin",
    lockEntries: yield* parseLockEntries(options.stateStore, options.appRoot, lockfilePath),
    stagedLocks: new Map(),
    walk: { selectors: new Map(), issues: new Map(), complete: true },
    noNetwork: false,
    loadPolicy: options.loadPolicy ?? DEFAULT_LANDOFILE_LOAD_POLICY,
    ...(options.ports === undefined ? {} : { ports: options.ports }),
    stateStore: options.stateStore,
    ...(options.onRelaxedRead === undefined ? {} : { onRelaxedRead: options.onRelaxedRead }),
  };
  const sourcePath = options.sourcePath ?? join(options.appRoot, ".lando.yml");
  const existingLocalIncludePaths = getLocalIncludePaths(options.landofile);
  const existingVersionConstraints = authoredVersionConstraintEntries(options, sourcePath);
  const resolution = yield* resolveTree(
    options.landofile,
    ctx,
    0,
    [options.appRoot],
    sourcePath,
    options.layer ?? "canonical",
    options.order ?? 3,
  );
  yield* writeLockfileIfNeeded(ctx);
  if (retainLayers) return rememberLandofileAppRoot(resolution, options.appRoot);
  const unresolved = mergeLandofiles(getIncludeOverlays(resolution)) as LandofileShape;
  rememberLocalIncludePaths(unresolved, getLocalIncludePaths(resolution));
  rememberLandofileIncludeSources(unresolved, getLandofileIncludeSources(resolution));
  rememberLandofileReferencedFiles(unresolved, getLandofileReferencedFiles(resolution));
  rememberVersionConstraintEntries(unresolved, getVersionConstraintEntries(resolution, sourcePath));
  if (options.resolveTooling === false) return rememberLandofileAppRoot(unresolved, options.appRoot);
  const tooling = yield* resolveToolingIncludes({
    loadScope: ctx.loadScope,
    landofile: unresolved,
    appRoot: options.appRoot,
    sourceRoot: options.appRoot,
    loadPolicy: ctx.loadPolicy,
    ...(ctx.onRelaxedRead === undefined ? {} : { onRelaxedRead: ctx.onRelaxedRead }),
    ...(options.maxDepth === undefined ? {} : { maxDepth: options.maxDepth }),
  });
  const decoded = yield* validateLandofile(
    lockfilePath,
    withResolvedTooling(unresolved as Record<string, unknown>, tooling.tooling),
  );
  rememberLandofileReferencedFiles(decoded, [
    ...getLandofileReferencedFiles(unresolved),
    ...tooling.referencedFiles,
  ]);
  const versionConstraints =
    authoredIncludeEntries(options.landofile).length === 0
      ? existingVersionConstraints
      : getVersionConstraintEntries(unresolved, sourcePath);
  return rememberLandofileAppRoot(
    rememberVersionConstraintEntries(
      rememberInternalToolingTasks(
        rememberLandofileIncludeSources(
          rememberLocalIncludePaths(decoded, [
            ...new Set([
              ...existingLocalIncludePaths,
              ...getLocalIncludePaths(unresolved),
              ...tooling.localFragmentPaths,
            ]),
          ]),
          getLandofileIncludeSources(unresolved),
        ),
        winningInternalToolingTasks([
          { tooling: tooling.tooling, internalTaskIds: tooling.internalTaskIds },
          { tooling: unresolved.tooling, internalTaskIds: getInternalToolingTasks(unresolved) },
        ]),
      ),
      versionConstraints,
    ),
    options.appRoot,
  );
});

export const resolveLandofileIncludes = (options: ResolveLandofileIncludesOptions) =>
  resolveIncludes(options);
export const resolveLandofileIncludeLayers = Effect.fnUntraced(function* (
  options: Omit<ResolveLandofileIncludesOptions, "landofile"> & {
    readonly landofile: LandofileDecodedOverlay;
  },
): Effect.fn.Return<
  { readonly provenance: LandofileShape; readonly overlays: ReadonlyArray<LandofileDecodedOverlay> },
  ResolveIncludesError
> {
  const provenance = yield* resolveIncludes(
    { ...options, landofile: options.landofile as LandofileShape },
    true,
  );
  return { provenance, overlays: getIncludeOverlays(provenance) };
});
