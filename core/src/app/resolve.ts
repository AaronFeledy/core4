import { dirname } from "node:path";

import { Effect } from "effect";

import type { App, AppSelector, LandoRuntimeServices } from "@lando/sdk/app";
import { AppResolveError } from "@lando/sdk/errors";
import type { AppPlan, LandofileShape } from "@lando/sdk/schema";
import { AppPlanner, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";

import {
  type ResolvedAppTarget,
  assertUserAppIdNotReserved,
  loadUserLandofileAt,
  loadUserLandofileFile,
  userAppRef,
  withResolvedCwd,
} from "../cli/app-resolution.ts";
import { resolveLandofileIncludes } from "../landofile/includes.ts";
import { makeAppHandle } from "./handle.ts";
import { type NormalizedAppSelector, normalizeAppSelector } from "./selector.ts";

type ResolvePlanServices = LandofileService | AppPlanner | RuntimeProviderRegistry;

interface ResolvedLandofilePlan {
  readonly plan: AppPlan;
  readonly landofile: LandofileShape;
}

const toAppResolveError = (cause: unknown): AppResolveError => {
  const tag = typeof cause === "object" && cause !== null ? (cause as { _tag?: string })._tag : undefined;
  if (tag === "AppResolveError") return cause as AppResolveError;
  if (tag === "AppIdReservedError") {
    return new AppResolveError({
      message: "The resolved app uses the reserved `global` id and cannot be opened as a user app.",
      reason: "mismatch",
      detail: "reserved-id",
      cause,
    });
  }
  return new AppResolveError({
    message: tag ? `Failed to resolve app (${tag}).` : "Failed to resolve app.",
    reason: "not-found",
    cause,
  });
};

const planResolvedLandofile = (
  landofile: LandofileShape,
  root: string,
): Effect.Effect<ResolvedLandofilePlan, AppResolveError, ResolvePlanServices> =>
  Effect.gen(function* () {
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;
    const capabilities = yield* registry.capabilities;
    const plan = yield* withResolvedCwd(
      root,
      Effect.suspend(() => planner.plan(landofile, capabilities)),
    );
    return { plan, landofile };
  }).pipe(Effect.catchAll((cause) => Effect.fail(toAppResolveError(cause))));

const planAt = (
  dir: string | undefined,
): Effect.Effect<ResolvedLandofilePlan, AppResolveError, ResolvePlanServices> =>
  Effect.gen(function* () {
    const root = dir ?? process.cwd();
    const landofileService = yield* LandofileService;
    const landofile = yield* loadUserLandofileAt(landofileService, root);
    return yield* planResolvedLandofile(landofile, root);
  }).pipe(Effect.catchAll((cause) => Effect.fail(toAppResolveError(cause))));

const planFromShape = (
  shape: LandofileShape,
  appRoot: string,
): Effect.Effect<ResolvedLandofilePlan, AppResolveError, ResolvePlanServices> =>
  Effect.gen(function* () {
    const landofile = yield* resolveLandofileIncludes({ landofile: shape, appRoot });
    yield* assertUserAppIdNotReserved(landofile);
    return yield* planResolvedLandofile(landofile, appRoot);
  }).pipe(Effect.catchAll((cause) => Effect.fail(toAppResolveError(cause))));

const planFromLandofileFile = (
  filePath: string,
): Effect.Effect<ResolvedLandofilePlan, AppResolveError, ResolvePlanServices> =>
  Effect.gen(function* () {
    const landofile = yield* loadUserLandofileFile(filePath);
    return yield* planResolvedLandofile(landofile, dirname(filePath));
  }).pipe(Effect.catchAll((cause) => Effect.fail(toAppResolveError(cause))));

const selectorMismatch = (detail: string): AppResolveError =>
  new AppResolveError({
    message: "App selector fields do not resolve to the same app.",
    reason: "mismatch",
    detail,
  });

const sameResolvedApp = (left: AppPlan, right: AppPlan): boolean =>
  left.id === right.id && left.root === right.root;

const validatePlanMatch = (
  primary: ResolvedLandofilePlan,
  lower: Effect.Effect<ResolvedLandofilePlan, AppResolveError, ResolvePlanServices>,
  detail: string,
): Effect.Effect<ResolvedLandofilePlan, AppResolveError, ResolvePlanServices> =>
  lower.pipe(
    Effect.flatMap((resolved) =>
      sameResolvedApp(primary.plan, resolved.plan)
        ? Effect.succeed(primary)
        : Effect.fail(selectorMismatch(detail)),
    ),
  );

const validateLowerSelectors = (
  primary: Effect.Effect<ResolvedLandofilePlan, AppResolveError, ResolvePlanServices>,
  checks: ReadonlyArray<
    readonly [Effect.Effect<ResolvedLandofilePlan, AppResolveError, ResolvePlanServices>, string]
  >,
): Effect.Effect<ResolvedLandofilePlan, AppResolveError, ResolvePlanServices> =>
  primary.pipe(
    Effect.flatMap((resolved) =>
      checks.reduce(
        (effect, [check, detail]) =>
          effect.pipe(Effect.flatMap(() => validatePlanMatch(resolved, check, detail))),
        Effect.succeed(resolved) as Effect.Effect<
          ResolvedLandofilePlan,
          AppResolveError,
          ResolvePlanServices
        >,
      ),
    ),
  );

const resolvePlan = (
  selector: NormalizedAppSelector,
): Effect.Effect<ResolvedLandofilePlan, AppResolveError, ResolvePlanServices> => {
  switch (selector.kind) {
    case "cwd":
      return planAt(selector.cwd);
    case "root":
      return validateLowerSelectors(
        planAt(selector.root),
        selector.cwd === undefined ? [] : [[planAt(selector.cwd), "root+cwd"]],
      );
    case "landofile-path":
      return validateLowerSelectors(planFromLandofileFile(selector.path), [
        ...(selector.root === undefined ? [] : ([[planAt(selector.root), "landofile+root"]] as const)),
        ...(selector.cwd === undefined ? [] : ([[planAt(selector.cwd), "landofile+cwd"]] as const)),
      ]);
    case "landofile-shape":
      return validateLowerSelectors(
        planFromShape(selector.shape, selector.root),
        selector.cwd === undefined ? [] : [[planAt(selector.cwd), "landofile+cwd"]],
      );
    case "id":
      return selector.root === undefined && selector.cwd === undefined
        ? Effect.fail(
            new AppResolveError({
              message: `Cannot resolve app by id \`${selector.id}\` without a known root at this bootstrap level.`,
              reason: "unknown-id",
              detail: selector.id,
            }),
          )
        : validateLowerSelectors(
            planAt(selector.root ?? selector.cwd),
            selector.root !== undefined && selector.cwd !== undefined
              ? [[planAt(selector.cwd), "id+root+cwd"]]
              : [],
          ).pipe(
            Effect.flatMap((resolved) =>
              resolved.plan.id === selector.id
                ? Effect.succeed(resolved)
                : Effect.fail(
                    new AppResolveError({
                      message: `App id \`${selector.id}\` does not match the app \`${resolved.plan.id}\` at the selected root.`,
                      reason: "mismatch",
                      detail: "id+root",
                    }),
                  ),
            ),
          );
  }
};

const targetFromResolved = (resolved: ResolvedLandofilePlan): ResolvedAppTarget => ({
  plan: resolved.plan,
  landofile: resolved.landofile,
  root: resolved.plan.root,
  app: userAppRef(resolved.plan),
});

/**
 * Builds the branded `App` handle for an already-resolved target, capturing the
 * ambient runtime so handle methods need no further services.
 */
export const buildAppHandle = (target: ResolvedAppTarget): Effect.Effect<App, never, LandoRuntimeServices> =>
  Effect.gen(function* () {
    const runtime = yield* Effect.runtime<LandoRuntimeServices>();
    const { appOperations } = yield* Effect.promise(() => import("./operations.ts"));
    return makeAppHandle(target, runtime, appOperations);
  });

/**
 * Resolves an app from an optional `AppSelector` and returns a stable, branded
 * `App` handle bound to the current runtime. The resolved plan, root, and
 * Landofile are captured once; handle methods reuse them instead of
 * re-discovering from the host's working directory. Selector precedence is
 * `id > landofile > root > cwd`.
 */
export const resolveApp = (
  selector?: AppSelector,
): Effect.Effect<App, AppResolveError, LandoRuntimeServices> =>
  Effect.gen(function* () {
    const normalized = yield* normalizeAppSelector(selector);
    const resolved = yield* resolvePlan(normalized);
    return yield* buildAppHandle(targetFromResolved(resolved));
  });
