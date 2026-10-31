import { join } from "node:path";
import { Effect } from "effect";
import { rememberLandofileAppRoot } from "./app-root-provenance.ts";
import { copyLandofileProvenance } from "./copy-provenance.ts";
import {
  type ResolveContext,
  type ResolveLandofileIncludesOptions,
  resolveCacheRoot,
} from "./include-context.ts";
import { ownVersionConstraintEntries } from "./include-fragment.ts";
import { getIncludeOverlays, includeAcquisitionView } from "./include-layer-overlays.ts";
import {
  type IncludeResolutionSession,
  createIncludeResolutionSession,
  publishIncludeProposals,
} from "./include-session.ts";
import { hasResolvableIncludes } from "./include-source.ts";
import { resolveTree } from "./include-tree.ts";
import { ensureConsistentRoot } from "./load-context.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "./load-expression-file.ts";
import { finalizeLandofile } from "./pipeline/finalize.ts";
import { foldAuthoredOverlays } from "./pipeline/fold.ts";
import { prepareLandofileValue } from "./source.ts";
import { validationErrorFromCause } from "./validation.ts";
import { getVersionConstraintEntries, rememberVersionConstraintEntries } from "./version-constraint.ts";

const resolveIncludes = Effect.fn("Landofile.resolveIncludes")(function* (
  options: Omit<ResolveLandofileIncludesOptions, "stateStore" | "lockfilePath">,
  session: IncludeResolutionSession,
) {
  const file = options.sourcePath ?? join(options.appRoot, ".lando.yml");
  const acquisition = yield* Effect.try({
    try: () => includeAcquisitionView(options.landofile),
    catch: (cause) => validationErrorFromCause(file, options.landofile, cause),
  });
  if (!hasResolvableIncludes(acquisition))
    return rememberLandofileAppRoot(
      rememberVersionConstraintEntries(
        options.landofile,
        options.layer === undefined || options.order === undefined
          ? getVersionConstraintEntries(acquisition, file)
          : ownVersionConstraintEntries(acquisition, file, options.layer, options.order),
      ),
      options.appRoot,
    );
  const ctx: ResolveContext = {
    pendingSites: options.pendingSites,
    loadScope: options.loadScope,
    appRoot: options.appRoot,
    sourceRoot: options.appRoot,
    userOwned: false,
    cacheRoot: yield* resolveCacheRoot(options.cacheRoot, options.ports),
    lockfilePath: session.lockfilePath,
    deps: options.deps ?? {},
    maxDepth: options.maxDepth ?? 8,
    mode: "pin",
    lockEntries: yield* session.existingPins,
    stagedLocks: session.selectedPins,
    walk: { selectors: session.selectors, issues: new Map(), complete: true },
    noNetwork: session.readOnly,
    loadPolicy: options.loadPolicy ?? DEFAULT_LANDOFILE_LOAD_POLICY,
    ...(options.ports === undefined ? {} : { ports: options.ports }),
    ...(options.onRelaxedRead === undefined ? {} : { onRelaxedRead: options.onRelaxedRead }),
  };
  const resolved = yield* resolveTree(
    options.landofile,
    ctx,
    0,
    [options.appRoot],
    file,
    options.layer ?? "canonical",
    options.order ?? 3,
  );
  return rememberLandofileAppRoot(resolved, options.appRoot);
});

export const resolveLandofileIncludeLayers = Effect.fnUntraced(function* (
  options: Omit<ResolveLandofileIncludesOptions, "stateStore" | "lockfilePath">,
  session: IncludeResolutionSession,
) {
  const provenance = yield* resolveIncludes(options, session);
  return { provenance, overlays: getIncludeOverlays(provenance) };
});
export const resolveLandofileIncludes = Effect.fnUntraced(function* (
  options: ResolveLandofileIncludesOptions,
) {
  yield* ensureConsistentRoot(options.appRoot);
  const session = yield* createIncludeResolutionSession(options);
  const file = options.sourcePath ?? join(options.appRoot, ".lando.yml");
  const pendingSites = options.pendingSites ?? options.loadScope?.pendingSites ?? [];
  const prepared = yield* prepareLandofileValue({
    file,
    value: options.landofile,
    context: {
      appRoot: options.appRoot,
      layer: options.layer ?? "canonical",
      pendingSites,
      policy: options.loadPolicy ?? DEFAULT_LANDOFILE_LOAD_POLICY,
    },
  });
  const provenance = yield* resolveIncludes({ ...options, pendingSites, landofile: prepared.value }, session);
  const document = copyLandofileProvenance(
    provenance,
    foldAuthoredOverlays(getIncludeOverlays(provenance), {
      file,
      layer: options.layer ?? "canonical",
      path: [],
    }),
  );
  const compiled = yield* finalizeLandofile(file, document, {
    pendingSites,
    appRoot: options.appRoot,
    ...(options.loadScope === undefined ? {} : { scope: { ...options.loadScope, pendingSites } }),
    ...(options.loadPolicy === undefined ? {} : { loadPolicy: options.loadPolicy }),
    ...(options.onRelaxedRead === undefined ? {} : { onRelaxedRead: options.onRelaxedRead }),
  });
  yield* publishIncludeProposals(session, options.stateStore);
  return compiled;
});
