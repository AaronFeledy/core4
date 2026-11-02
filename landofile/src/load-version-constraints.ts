import { LandofileParseError } from "@lando/sdk/errors";
import { isPlainRecord, withValueOrigins } from "@lando/sdk/landofile";
import { Effect } from "effect";
import { type LoadFailureRecorder, loadPathBlocked } from "./load-failures.ts";
import { type LandofileLoadScope, materializeLandofileLayer } from "./pipeline/materialize.ts";
import { rememberOrigins } from "./pipeline/origins.ts";
import {
  type VersionConstraintEntry,
  getVersionConstraintEntries,
  isValidSemverRange,
} from "./version-constraint.ts";

export const loadVersionConstraints = Effect.fnUntraced(function* (
  document: Record<string, unknown>,
  file: string,
  scope: LandofileLoadScope & { readonly recorder: LoadFailureRecorder },
) {
  const constraints: VersionConstraintEntry[] = [];
  for (const entry of getVersionConstraintEntries(document, file)) {
    const source = { file: entry.source, layer: entry.layer, path: ["lando"] };
    if (loadPathBlocked(scope.recorder, source)) continue;
    const authored = { lando: entry.range };
    const origins = withValueOrigins(authored, (path) => ({ ...source, path })).origins;
    const resolved = yield* materializeLandofileLayer(
      entry.source,
      rememberOrigins(authored, origins),
      scope,
    );
    if (loadPathBlocked(scope.recorder, source)) continue;
    const range = isPlainRecord(resolved) ? resolved.lando : undefined;
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
