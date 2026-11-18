import { join } from "node:path";
import { isPlainRecord } from "@lando/sdk/landofile";
import { Effect } from "effect";
import type { ResolvedTree } from "./include-tree.ts";
import { prepareIncludeAcquisition } from "./load-acquisition.ts";
import type { LoadFailureRecorder } from "./load-failures.ts";
import { loadVersionConstraints } from "./load-version-constraints.ts";
import { foldAuthoredOverlays } from "./pipeline/fold.ts";
import { type LandofileLoadScope, materializeLandofileLayer } from "./pipeline/materialize.ts";
import { type AuthoredDocument, combineProvenance } from "./provenance.ts";
import { resolveToolingIncludes } from "./tooling-includes.ts";
import { validationErrorFromCause } from "./validation.ts";

export const inspectIncludeComposition = Effect.fnUntraced(function* (
  resolved: readonly ResolvedTree[],
  context: {
    readonly appRoot: string;
    readonly scope: LandofileLoadScope;
    readonly recorder: LoadFailureRecorder;
  },
) {
  const file = join(context.appRoot, ".lando.yml");
  const folded = foldAuthoredOverlays(
    resolved.flatMap(({ overlays }) => overlays),
    { file, layer: "canonical", path: [] },
  );
  const document: AuthoredDocument = {
    value: isPlainRecord(folded.value) ? folded.value : {},
    provenance: combineProvenance(
      resolved.map(({ document }) => document.provenance),
      folded.origins,
    ),
  };
  const scope = { ...context.scope, recorder: context.recorder };
  const value = yield* materializeLandofileLayer(file, document, {
    ...scope,
    siteFilter: (site) => site.path[0] !== "lando",
  });
  if (!isPlainRecord(value.value))
    context.recorder.record(validationErrorFromCause(file, value.value, undefined));
  const acquired = prepareIncludeAcquisition(value, {
    recorder: context.recorder,
    source: { file, layer: "canonical", path: [] },
  });
  yield* resolveToolingIncludes({
    document: acquired,
    appRoot: context.appRoot,
    sourceRoot: context.appRoot,
    loadScope: scope,
    recorder: context.recorder,
  });
  yield* loadVersionConstraints(acquired.provenance.versionConstraints, scope);
});
