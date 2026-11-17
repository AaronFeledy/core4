import { LandofileParseError } from "@lando/sdk/errors";
import { Effect } from "effect";
import { type LoadFailureRecorder, loadPathBlocked } from "./load-failures.ts";
import { type LandofileLoadScope, materializeLandofileLayer } from "./pipeline/materialize.ts";
import { authoredDocumentFrom } from "./provenance.ts";
import { type VersionConstraintEntry, isValidSemverRange } from "./version-constraint.ts";

/**
 * Materialize the ranges recorded while composing. Each `lando:` value is
 * re-evaluated in isolation with an origin that names the entry's own file, so
 * a whole-value expression is attributed where it was authored.
 */
export const loadVersionConstraints = Effect.fnUntraced(function* (
  entries: readonly VersionConstraintEntry[],
  scope: LandofileLoadScope & { readonly recorder: LoadFailureRecorder },
) {
  const constraints: VersionConstraintEntry[] = [];
  for (const entry of entries) {
    const source = { file: entry.source, layer: entry.layer, path: ["lando"] };
    if (loadPathBlocked(scope.recorder, source)) continue;
    const authored = { lando: entry.range };
    const resolved = yield* materializeLandofileLayer(
      entry.source,
      authoredDocumentFrom(authored, source),
      scope,
    );
    if (loadPathBlocked(scope.recorder, source)) continue;
    const range = resolved.value.lando;
    if (typeof range !== "string" || !isValidSemverRange(range)) {
      scope.recorder.record(
        new LandofileParseError({
          message: `Landofile "lando:" is not a valid semver range: "${range}". Use npm semver syntax such as ">=4.1 <5", "^4", or "4.x".`,
          filePath: entry.source,
          sourceFile: entry.source,
          sourcePath: ["lando"],
          layer: entry.layer,
          line: undefined,
          column: undefined,
          remediation: `Edit the lando: field in ${entry.source} to a valid npm semver range such as ">=4.1 <5", "^4", or "4.x".`,
        }),
      );
      continue;
    }
    constraints.push({ ...entry, range });
  }
  return constraints;
});
