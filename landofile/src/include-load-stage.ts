import { join } from "node:path";
import { isPlainRecord } from "@lando/sdk/landofile";
import { Effect } from "effect";
import { getIncludeOverlays, includeAcquisitionView } from "./include-layer-overlays.ts";
import { prepareIncludeAcquisition } from "./load-acquisition.ts";
import type { LoadFailureRecorder } from "./load-failures.ts";
import { loadVersionConstraints } from "./load-version-constraints.ts";
import { foldAuthoredOverlays } from "./pipeline/fold.ts";
import { type LandofileLoadScope, materializeLandofileLayer } from "./pipeline/materialize.ts";
import { getOrigins } from "./pipeline/origins.ts";
import { resolveToolingIncludes } from "./tooling-includes.ts";
import { validationErrorFromCause } from "./validation.ts";
import { getVersionConstraintEntries, rememberVersionConstraintEntries } from "./version-constraint.ts";

export const inspectIncludeComposition = Effect.fnUntraced(function* (
  resolved: readonly Record<string, unknown>[],
  context: {
    readonly appRoot: string;
    readonly scope: LandofileLoadScope;
    readonly recorder: LoadFailureRecorder;
  },
) {
  const file = join(context.appRoot, ".lando.yml");
  const document = foldAuthoredOverlays(resolved.flatMap(getIncludeOverlays), {
    file,
    layer: "canonical",
    path: [],
  });
  rememberVersionConstraintEntries(
    document,
    resolved.flatMap((value) => getVersionConstraintEntries(value, file)),
  );
  const scope = { ...context.scope, recorder: context.recorder };
  const value = yield* materializeLandofileLayer(file, document, {
    ...scope,
    siteFilter: (site) => site.path[0] !== "lando",
  });
  if (!isPlainRecord(value)) context.recorder.record(validationErrorFromCause(file, value, undefined));
  const acquired = prepareIncludeAcquisition(isPlainRecord(value) ? value : document, {
    recorder: context.recorder,
    source: { file, layer: "canonical", path: [] },
  });
  yield* resolveToolingIncludes({
    landofile: includeAcquisitionView(acquired),
    origins: getOrigins(acquired),
    appRoot: context.appRoot,
    sourceRoot: context.appRoot,
    loadScope: scope,
    recorder: context.recorder,
  });
  yield* loadVersionConstraints(document, file, scope);
});
