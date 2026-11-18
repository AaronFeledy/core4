import {
  type ResolvedAppTarget,
  type UserAppResolution,
  type UserLandofileError,
  makeUserAppResolution,
  userAppRef,
} from "@lando/landofile/app-resolution";
import { LANDOFILE_NAME } from "@lando/landofile/discovery";
import { discoveryCwd } from "@lando/landofile/operation-discovery";
import type { LandofileRuntimeInputs } from "@lando/landofile/ports";
import { type LandofileProvenance, versionConstraintsFor } from "@lando/landofile/provenance";
import {
  type VersionConstraintEntry,
  evaluateVersionConstraints,
  isVersionConstraintSkipped,
} from "@lando/landofile/version-constraint";
import { AppResolveError, LandofileParseError, LandofileVersionConstraintError } from "@lando/sdk/errors";
import type { AbsolutePath, LandofileShape, LoadScopedLandofile } from "@lando/sdk/schema";
import { AppPlanner, LandofileService, Renderer, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import { HostExecutionDefaults } from "../services/host-execution-context.ts";
import { scopedLandofileRuntimeInputs } from "../services/landofile-live.ts";
import { CORE_VERSION } from "../version.ts";
import { commandWarningsUseMachineOutput, recordCommandWarning } from "./command-warnings.ts";

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

const warnConstraintSkipped = Effect.fnUntraced(function* (
  unsatisfied: ReadonlyArray<VersionConstraintEntry>,
  runningVersion: string,
): Effect.fn.Return<void> {
  const message = `Skipping unsatisfied Lando version constraint ${unsatisfied
    .map((entry) => `"${entry.range}"`)
    .join(", ")} (running ${runningVersion}); LANDO_SKIP_VERSION_CONSTRAINT is set.`;
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
    yield* renderer.value.message.warn(message).pipe(Effect.catch(() => Effect.void));
  }
});

export const assertLandoVersionConstraint = (
  landofile: LandofileShape,
  provenance: LandofileProvenance | undefined,
  options?: LandoVersionConstraintOptions,
): Effect.Effect<void, LandofileParseError | LandofileVersionConstraintError> => {
  const constraints = versionConstraintsFor(provenance, landofile, options?.sourcePath ?? LANDOFILE_NAME);
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
        remediation: `Edit the lando: field in ${bad.source}: ${RANGE_SYNTAX_REMEDIATION}`,
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

export const makeEngineUserAppResolution = (inputs: LandofileRuntimeInputs): UserAppResolution =>
  makeUserAppResolution({
    inputs,
    assertVersionConstraint: (landofile, provenance, sourcePath) =>
      assertLandoVersionConstraint(landofile, provenance, {
        ...(sourcePath === undefined ? {} : { sourcePath }),
        ...(inputs.templates.context?.env === undefined ? {} : { env: inputs.templates.context.env }),
      }),
  });

const userAppResolution = (): Effect.Effect<UserAppResolution> =>
  Effect.map(scopedLandofileRuntimeInputs, makeEngineUserAppResolution);

export const loadUserLandofile = Effect.fnUntraced(function* (
  service: Parameters<UserAppResolution["loadUserLandofile"]>[0],
  options?: { readonly env: Readonly<Record<string, string | undefined>> },
): Effect.fn.Return<LoadScopedLandofile, UserLandofileError> {
  const host = yield* HostExecutionDefaults;
  const load = Effect.flatMap(userAppResolution(), (resolution) => resolution.loadUserLandofile(service));
  if (options === undefined) return yield* load;
  return yield* load.pipe(
    Effect.provideService(HostExecutionDefaults, {
      cwd: host?.cwd ?? (yield* discoveryCwd()),
      env: options.env,
      platform: host?.platform ?? process.platform,
    }),
  );
});
export const loadUserLandofileAt: UserAppResolution["loadUserLandofileAt"] = (...args) =>
  Effect.flatMap(userAppResolution(), (resolution) => resolution.loadUserLandofileAt(...args));
export const loadUserLandofileFile = (filePath: string) =>
  Effect.flatMap(scopedLandofileRuntimeInputs, (inputs) =>
    makeEngineUserAppResolution(inputs).loadUserLandofileFile(filePath),
  );

export const planDesiredApp = Effect.gen(function* () {
  const landofileService = yield* LandofileService;
  const registry = yield* RuntimeProviderRegistry;
  const planner = yield* AppPlanner;
  const landofile = yield* loadUserLandofile(landofileService);
  const capabilities = yield* registry.capabilities;
  const plan = yield* planner.plan(landofile, capabilities);
  return { plan, landofile };
});

export const resolveDesiredAppTarget = Effect.map(
  planDesiredApp,
  ({ plan, landofile }) =>
    ({ plan, root: plan.root, app: userAppRef(plan), landofile }) satisfies ResolvedAppTarget,
);

/**
 * Loads the Landofile at exactly `root` and plans it. A Landofile in a parent folder
 * belongs to another app, so a loader that walks upward is refused.
 */
export const resolveDesiredAppTargetAtRoot = Effect.fn("AppPlanner.resolveDesiredTargetAtRoot")(function* (
  root: AbsolutePath,
) {
  const landofile = yield* loadUserLandofileAt(yield* LandofileService, root);
  if (landofile.context.appRoot !== root)
    return yield* Effect.fail(
      new AppResolveError({
        reason: "mismatch",
        detail: "canonical-root",
        message: `The Landofile loaded for ${root} belongs to app root ${landofile.context.appRoot}.`,
        remediation: "Run the command from the app root that owns this Landofile.",
      }),
    );
  const planner = yield* AppPlanner;
  const registry = yield* RuntimeProviderRegistry;
  const plan = yield* planner.plan(landofile, yield* registry.capabilities);
  if (plan.root !== root)
    return yield* Effect.fail(
      new AppResolveError({
        reason: "mismatch",
        detail: "canonical-root",
        message: `The Landofile at ${root} resolves to app root ${plan.root}.`,
        remediation: "Run the command from the app root that owns this Landofile.",
      }),
    );
  return { plan, root: plan.root, app: userAppRef(plan), landofile } satisfies ResolvedAppTarget;
});
