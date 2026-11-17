import { join } from "node:path";
import { isPlainRecord } from "@lando/sdk/landofile";
import type { StateStoreShape } from "@lando/sdk/services";
import type { SourceSession } from "@lando/source-acquisition";
import { Effect } from "effect";
import {
  type ResolveContext,
  type ResolveIncludesError,
  type ResolveLandofileIncludesOptions,
  resolveCacheRoot,
} from "./include-context.ts";
import { ownVersionConstraintEntries } from "./include-fragment.ts";
import { includeAcquisitionView } from "./include-layer-overlays.ts";
import { loadIncludePins } from "./include-pins.ts";
import {
  type IncludeResolutionSession,
  createIncludeResolutionSession,
  publishIncludeProposals,
} from "./include-session.ts";
import { hasResolvableIncludes } from "./include-source.ts";
import { withIncludeSourceSession } from "./include-sources.ts";
import { type ResolvedTree, asOverlay, resolveTree } from "./include-tree.ts";
import { prepareIncludeAcquisition } from "./load-acquisition.ts";
import { ensureConsistentRoot } from "./load-context.ts";
import { DEFAULT_LANDOFILE_LOAD_POLICY } from "./load-expression-file.ts";
import { createLoadFailureRecorder } from "./load-failures.ts";
import { finalizeLandofile } from "./pipeline/finalize.ts";
import { foldAuthoredOverlays } from "./pipeline/fold.ts";
import { buildLandofileLoadScope } from "./pipeline/materialize.ts";
import type { AuthoredDocument, LandofileProvenance } from "./provenance.ts";
import { prepareLandofileValue } from "./source.ts";
import { validationErrorFromCause } from "./validation.ts";

export interface ResolveLandofileLayersOptions
  extends Omit<ResolveLandofileIncludesOptions, "landofile" | "stateStore" | "lockfilePath"> {
  readonly landofile: AuthoredDocument;
  readonly stateStore?: StateStoreShape;
  readonly lockfilePath?: string;
}

const resolveIncludes: (
  options: Omit<ResolveLandofileLayersOptions, "stateStore" | "lockfilePath">,
  session: IncludeResolutionSession,
  sourceSession: SourceSession | undefined,
) => Effect.Effect<ResolvedTree, ResolveIncludesError> = Effect.fnUntraced(
  function* (options, session, sourceSession) {
    const file = options.sourcePath ?? join(options.appRoot, ".lando.yml");
    const layer = options.layer ?? "canonical";
    const order = options.order ?? 3;
    const landofile =
      options.recorder === undefined
        ? options.landofile
        : prepareIncludeAcquisition(options.landofile, {
            recorder: options.recorder,
            source: { file, layer, path: [] },
          });
    const acquisition = yield* Effect.try({
      try: () => includeAcquisitionView(landofile.value),
      catch: (cause) => validationErrorFromCause(file, landofile.value, cause, landofile.provenance),
    });
    if (!hasResolvableIncludes(acquisition))
      return {
        document: {
          value: landofile.value,
          provenance: {
            ...landofile.provenance,
            appRoot: options.appRoot,
            versionConstraints: ownVersionConstraintEntries(landofile, file, layer, order),
          },
        },
        overlays: [asOverlay(landofile)],
      };
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
      ...(sourceSession === undefined ? {} : { sourceSession }),
      ...(options.onRelaxedRead === undefined ? {} : { onRelaxedRead: options.onRelaxedRead }),
    };
    const resolved = yield* resolveTree(landofile, ctx, {
      depth: 0,
      stack: [options.appRoot],
      source: file,
      layer,
      order,
    });
    return {
      document: {
        value: resolved.document.value,
        provenance: { ...resolved.document.provenance, appRoot: options.appRoot },
      },
      overlays: resolved.overlays,
    };
  },
);

export const resolveLandofileIncludeLayers = Effect.fnUntraced(function* (
  options: ResolveLandofileLayersOptions,
  session: IncludeResolutionSession,
) {
  if (!hasResolvableIncludes(includeAcquisitionView(options.landofile.value)))
    return yield* resolveIncludes(options, session, undefined);
  const cacheRoot = yield* resolveCacheRoot(options.cacheRoot, options.ports);
  return yield* withIncludeSourceSession(
    {
      cacheRoot,
      stateStore: options.stateStore,
      ports: options.ports,
      deps: options.deps,
      includeSession: session,
    },
    (sourceSession) => resolveIncludes({ ...options, cacheRoot }, session, sourceSession),
  );
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
    ...(options.provenance === undefined ? {} : { provenance: options.provenance }),
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
      (yield* buildLandofileLoadScope([{ file, value: prepared.value.value }], undefined, pendingSites))),
    pendingSites,
    recorder,
  };
  const resolved = yield* resolveLandofileIncludeLayers(
    { ...options, recorder, pendingSites, loadScope: scope, landofile: prepared.value },
    session,
  );
  const folded = foldAuthoredOverlays(resolved.overlays, {
    file,
    layer: options.layer ?? "canonical",
    path: [],
  });
  const provenance: LandofileProvenance = { ...resolved.document.provenance, origins: folded.origins };
  const compiled = yield* finalizeLandofile(
    file,
    { value: isPlainRecord(folded.value) ? folded.value : {}, provenance },
    {
      pendingSites,
      recorder,
      appRoot: options.appRoot,
      scope,
      ...(options.loadPolicy === undefined ? {} : { loadPolicy: options.loadPolicy }),
      ...(options.onRelaxedRead === undefined ? {} : { onRelaxedRead: options.onRelaxedRead }),
    },
  );
  yield* publishIncludeProposals(session, options.stateStore);
  return compiled;
}, Effect.scoped);
