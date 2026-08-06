import { Effect, Option } from "effect";

import { LandofileParseError, LandofileVersionConstraintError } from "@lando/sdk/errors";
import type { LandofileShape } from "@lando/sdk/schema";
import { Renderer } from "@lando/sdk/services";

import { type UserAppResolution, makeUserAppResolution } from "@lando/landofile/app-resolution";
import { LANDOFILE_NAME } from "@lando/landofile/discovery";
import {
  type VersionConstraintEntry,
  evaluateVersionConstraints,
  getVersionConstraintEntries,
  isVersionConstraintSkipped,
} from "@lando/landofile/version-constraint";
import { commandWarningsUseMachineOutput, recordCommandWarning } from "../cli/command-warnings.ts";
import { landofileRuntimeInputs } from "../services/landofile-live.ts";
import { CORE_VERSION } from "../version.ts";

export type { ResolvedAppTarget, UserLandofileError } from "@lando/landofile/app-resolution";
export {
  assertUserAppIdNotReserved,
  userAppRef,
  withResolvedCwd,
} from "@lando/landofile/app-resolution";

export interface LandoVersionConstraintOptions {
  readonly runningVersion?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly sourcePath?: string;
}

const RANGE_SYNTAX_REMEDIATION = 'Use a valid semver range such as ">=4.1 <5", "^4.0.0", or "~4.1".';
const VERSION_CONSTRAINT_REMEDIATION =
  "Run `lando update` to move to a satisfying Lando version, or edit the `lando:` constraint in your Landofile.";

const warnConstraintSkipped = (
  unsatisfied: ReadonlyArray<VersionConstraintEntry>,
  runningVersion: string,
): Effect.Effect<void> => {
  const message = `Skipping unsatisfied Lando version constraint ${unsatisfied
    .map((entry) => `"${entry.range}"`)
    .join(", ")} (running ${runningVersion}); LANDO_SKIP_VERSION_CONSTRAINT is set.`;
  return Effect.gen(function* () {
    yield* Effect.forEach(
      unsatisfied,
      (entry) =>
        recordCommandWarning({
          code: "LANDO_VERSION_CONSTRAINT_SKIPPED",
          message,
          remediation: VERSION_CONSTRAINT_REMEDIATION,
          context: {
            range: entry.range,
            source: entry.source,
            layer: entry.layer,
            order: String(entry.order),
            runningVersion,
          },
        }),
      { discard: true },
    );
    const renderer = yield* Effect.serviceOption(Renderer);
    const machineOutput = yield* commandWarningsUseMachineOutput;
    if (!machineOutput && Option.isSome(renderer)) {
      yield* renderer.value.message.warn(message).pipe(Effect.catchAll(() => Effect.void));
    }
  });
};

export const assertLandoVersionConstraint = (
  landofile: LandofileShape,
  options?: LandoVersionConstraintOptions,
): Effect.Effect<void, LandofileParseError | LandofileVersionConstraintError> => {
  const constraints = getVersionConstraintEntries(landofile, options?.sourcePath ?? LANDOFILE_NAME);
  if (constraints.length === 0) return Effect.void;

  const runningVersion = options?.runningVersion ?? CORE_VERSION;
  const env = options?.env ?? process.env;
  const { invalid, unsatisfied } = evaluateVersionConstraints(constraints, runningVersion);
  const bad = invalid[0];
  if (bad !== undefined) {
    return Effect.fail(
      new LandofileParseError({
        message: `Landofile "lando:" is not a valid semver range: "${bad.range}". ${RANGE_SYNTAX_REMEDIATION}`,
        filePath: bad.source,
        line: undefined,
        column: undefined,
      }),
    );
  }
  if (unsatisfied.length === 0) return Effect.void;
  if (isVersionConstraintSkipped(env)) return warnConstraintSkipped(unsatisfied, runningVersion);

  return Effect.fail(
    new LandofileVersionConstraintError({
      message: `The running Lando version ${runningVersion} does not satisfy the Landofile \`lando:\` constraint ${unsatisfied
        .map(
          (entry: VersionConstraintEntry) =>
            `"${entry.range}" (${entry.source}; ${entry.layer} layer, order ${entry.order})`,
        )
        .join(", ")}.`,
      constraints: unsatisfied,
      runningVersion,
      remediation: VERSION_CONSTRAINT_REMEDIATION,
    }),
  );
};

const userAppResolution: UserAppResolution = makeUserAppResolution({
  inputs: landofileRuntimeInputs,
  assertVersionConstraint: (landofile, sourcePath) =>
    assertLandoVersionConstraint(landofile, sourcePath === undefined ? undefined : { sourcePath }),
});

export const loadUserLandofile = userAppResolution.loadUserLandofile;
export const loadUserLandofileAt = userAppResolution.loadUserLandofileAt;
export const loadUserLandofileFile = userAppResolution.loadUserLandofileFile;
