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
import { loadIncludePins } from "./include-pins.ts";
import {
  type IncludeResolutionSession,
  createIncludeResolutionSession,
  publishIncludeProposals,
} from "./include-session.ts";
import { hasResolvableIncludes } from "./include-source.ts";
import { resolveTree } from "./include-tree.ts";
import { prepareIncludeAcquisition } from "./load-acquisition.ts";
import { ensureConsistentRoot } from "./load-context.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "./load-expression-file.ts";
import { createLoadFailureRecorder } from "./load-failures.ts";
import { finalizeLandofile } from "./pipeline/finalize.ts";
import { foldAuthoredOverlays } from "./pipeline/fold.ts";
import { buildLandofileLoadScope } from "./pipeline/materialize.ts";
import { prepareLandofileValue } from "./source.ts";
import { validationErrorFromCause } from "./validation.ts";
import { getVersionConstraintEntries, rememberVersionConstraintEntries } from "./version-constraint.ts";

const resolveIncludes = Effect.fn("Landofile.resolveIncludes")(function* (
  options: Omit<ResolveLandofileIncludesOptions, "stateStore" | "lockfilePath">,
  session: IncludeResolutionSession,
) {
  const file = options.sourcePath ?? join(options.appRoot, ".lando.yml");
  const landofile =
    options.recorder === undefined
      ? options.landofile
      : prepareIncludeAcquisition(options.landofile, {
          recorder: options.recorder,
          source: { file, layer: options.layer ?? "canonical", path: [] },
        });
  const acquisition = yield* Effect.try({
    try: () => includeAcquisitionView(landofile),
    catch: (cause) => validationErrorFromCause(file, options.landofile, cause),
  });
  if (!hasResolvableIncludes(acquisition))
    return rememberLandofileAppRoot(
      rememberVersionConstraintEntries(
        landofile,
        options.layer === undefined || options.order === undefined
          ? getVersionConstraintEntries(acquisition, file)
          : ownVersionConstraintEntries(acquisition, file, options.layer, options.order),
      ),
      options.appRoot,
    );
  const pins = yield* loadIncludePins({
    pins: session.existingPins,
    lockfile: session.lockfilePath,
    recorder: options.recorder,
  });
  const ctx: ResolveContext = {
    recorder: options.recorder,
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
    lockEntries: pins.entries,
    lockAvailable: pins.available,
    stagedLocks: session.selectedPins,
    walk: { selectors: session.selectors, issues: new Map(), complete: true },
    noNetwork: session.readOnly,
    loadPolicy: options.loadPolicy ?? DEFAULT_LANDOFILE_LOAD_POLICY,
    ...(options.ports === undefined ? {} : { ports: options.ports }),
    ...(options.onRelaxedRead === undefined ? {} : { onRelaxedRead: options.onRelaxedRead }),
  };
  const resolved = yield* resolveTree(landofile, ctx, {
    depth: 0,
    stack: [options.appRoot],
    source: file,
    layer: options.layer ?? "canonical",
    order: options.order ?? 3,
  });
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
  const recorder = options.recorder ?? createLoadFailureRecorder();
  const prepared = yield* prepareLandofileValue({
    file,
    value: options.landofile,
    context: {
      appRoot: options.appRoot,
      layer: options.layer ?? "canonical",
      pendingSites,
      recorder,
      policy: options.loadPolicy ?? DEFAULT_LANDOFILE_LOAD_POLICY,
    },
  });
  const scope = {
    ...(options.loadScope ??
      (yield* buildLandofileLoadScope([{ file, value: prepared.value }], undefined, pendingSites))),
    pendingSites,
    recorder,
  };
  const provenance = yield* resolveIncludes(
    { ...options, recorder, pendingSites, loadScope: scope, landofile: prepared.value },
    session,
  );
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
    recorder,
    appRoot: options.appRoot,
    scope,
    ...(options.loadPolicy === undefined ? {} : { loadPolicy: options.loadPolicy }),
    ...(options.onRelaxedRead === undefined ? {} : { onRelaxedRead: options.onRelaxedRead }),
  });
  yield* publishIncludeProposals(session, options.stateStore);
  return compiled;
});
