import { dirname } from "node:path";

import { Effect } from "effect";

import type { App, AppSelector, LandoRuntimeServices } from "@lando/sdk/app";
import { AppResolveError } from "@lando/sdk/errors";
import type { AppPlan, LandofileShape } from "@lando/sdk/schema";
import { AppPlanner, LandofileService, RuntimeProviderRegistry } from "@lando/sdk/services";

import { assertUserAppIdNotReserved, loadUserLandofile } from "../cli/app-resolution.ts";
import { resolveLandofileIncludes } from "../landofile/includes.ts";
import { makeAppHandle } from "./handle.ts";
import { type NormalizedAppSelector, normalizeAppSelector } from "./selector.ts";

type ResolvePlanServices = LandofileService | AppPlanner | RuntimeProviderRegistry;

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

const withProcessCwd = <A, E>(
  cwd: string,
  use: Effect.Effect<A, E, ResolvePlanServices>,
): Effect.Effect<A, E | AppResolveError, ResolvePlanServices> =>
  Effect.acquireUseRelease(
    Effect.try({
      try: () => {
        const original = process.cwd();
        process.chdir(cwd);
        return original;
      },
      catch: (cause) =>
        new AppResolveError({
          message: `Unable to enter the app directory at ${cwd}.`,
          reason: "not-found",
          detail: cwd,
          cause,
        }),
    }),
    () => use,
    (original) => Effect.sync(() => process.chdir(original)),
  );

const planFromDiscovery: Effect.Effect<AppPlan, AppResolveError, ResolvePlanServices> = Effect.gen(
  function* () {
    const landofileService = yield* LandofileService;
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;
    const landofile = yield* loadUserLandofile(landofileService);
    const capabilities = yield* registry.capabilities;
    return yield* planner.plan(landofile, capabilities);
  },
).pipe(Effect.catchAll((cause) => Effect.fail(toAppResolveError(cause))));

const planFromShape = (
  shape: LandofileShape,
  appRoot: string,
): Effect.Effect<AppPlan, AppResolveError, ResolvePlanServices> =>
  Effect.gen(function* () {
    const registry = yield* RuntimeProviderRegistry;
    const planner = yield* AppPlanner;
    const landofile = yield* resolveLandofileIncludes({ landofile: shape, appRoot });
    const capabilities = yield* registry.capabilities;
    yield* assertUserAppIdNotReserved(landofile);
    return yield* planner.plan(landofile, capabilities);
  }).pipe(Effect.catchAll((cause) => Effect.fail(toAppResolveError(cause))));

const planAt = (dir: string | undefined): Effect.Effect<AppPlan, AppResolveError, ResolvePlanServices> =>
  dir === undefined || dir === process.cwd() ? planFromDiscovery : withProcessCwd(dir, planFromDiscovery);

const selectorMismatch = (detail: string): AppResolveError =>
  new AppResolveError({
    message: "App selector fields do not resolve to the same app.",
    reason: "mismatch",
    detail,
  });

const sameResolvedApp = (left: AppPlan, right: AppPlan): boolean =>
  left.id === right.id && left.root === right.root;

const validatePlanMatch = (
  primary: AppPlan,
  lower: Effect.Effect<AppPlan, AppResolveError, ResolvePlanServices>,
  detail: string,
): Effect.Effect<AppPlan, AppResolveError, ResolvePlanServices> =>
  lower.pipe(
    Effect.flatMap((resolved) =>
      sameResolvedApp(primary, resolved) ? Effect.succeed(primary) : Effect.fail(selectorMismatch(detail)),
    ),
  );

const validateLowerSelectors = (
  primary: Effect.Effect<AppPlan, AppResolveError, ResolvePlanServices>,
  checks: ReadonlyArray<readonly [Effect.Effect<AppPlan, AppResolveError, ResolvePlanServices>, string]>,
): Effect.Effect<AppPlan, AppResolveError, ResolvePlanServices> =>
  primary.pipe(
    Effect.flatMap((plan) =>
      checks.reduce(
        (effect, [check, detail]) =>
          effect.pipe(Effect.flatMap(() => validatePlanMatch(plan, check, detail))),
        Effect.succeed(plan) as Effect.Effect<AppPlan, AppResolveError, ResolvePlanServices>,
      ),
    ),
  );

const resolvePlan = (
  selector: NormalizedAppSelector,
): Effect.Effect<AppPlan, AppResolveError, ResolvePlanServices> => {
  switch (selector.kind) {
    case "cwd":
      return planAt(selector.cwd);
    case "root":
      return validateLowerSelectors(
        planAt(selector.root),
        selector.cwd === undefined ? [] : [[planAt(selector.cwd), "root+cwd"]],
      );
    case "landofile-path":
      return validateLowerSelectors(planAt(dirname(selector.path)), [
        ...(selector.root === undefined ? [] : ([[planAt(selector.root), "landofile+root"]] as const)),
        ...(selector.cwd === undefined ? [] : ([[planAt(selector.cwd), "landofile+cwd"]] as const)),
      ]);
    case "landofile-shape":
      return validateLowerSelectors(
        withProcessCwd(selector.root, planFromShape(selector.shape, selector.root)),
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
            Effect.flatMap((plan) =>
              plan.id === selector.id
                ? Effect.succeed(plan)
                : Effect.fail(
                    new AppResolveError({
                      message: `App id \`${selector.id}\` does not match the app \`${plan.id}\` at the selected root.`,
                      reason: "mismatch",
                      detail: "id+root",
                    }),
                  ),
            ),
          );
  }
};

/**
 * Resolves an app from an optional `AppSelector` and returns a stable, branded
 * `App` handle bound to the current runtime. Selector precedence and validation
 * use selector precedence `id > landofile > root > cwd`.
 */
export const resolveApp = (
  selector?: AppSelector,
): Effect.Effect<App, AppResolveError, LandoRuntimeServices> =>
  Effect.gen(function* () {
    const normalized = yield* normalizeAppSelector(selector);
    const plan = yield* resolvePlan(normalized);
    const runtime = yield* Effect.runtime<LandoRuntimeServices>();
    const { appOperations } = yield* Effect.promise(() => import("./operations.ts"));
    return makeAppHandle(plan, runtime, appOperations);
  });
