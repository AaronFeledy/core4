import type { RedactionService } from "@lando/redaction/service";
import { mapFailures } from "@lando/sdk/command-result";
import { SqlServiceAmbiguousError, SqlServiceNotFoundError } from "@lando/sdk/errors";
import { planAppIdentity, planDataId } from "@lando/sdk/schema";
import {
  AppPlanner,
  DatabaseCredentialConvergence,
  type DatabaseCredentialConvergenceRequest,
  EnvironmentValueResolver,
  PathsService,
  RuntimeProviderRegistry,
  type StateStore,
  UserAppResolver,
} from "@lando/sdk/services";
import type { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect, Equal, Layer } from "effect";
import { withAppMutationLock } from "./app-mutation-lock.ts";
import { catalogDatabase } from "./database-convergence/catalog.ts";
import { prepareReconciliation } from "./database-convergence/reconcile.ts";
import { targetError } from "./database-convergence/target.ts";

const resolveTarget = Effect.fn("DatabaseConvergence.resolveTarget")(function* (
  request: DatabaseCredentialConvergenceRequest,
) {
  const rejected = targetError(
    "target-changed",
    "Could not prove the same desired and applied database placement.",
    request.service,
  );
  const unavailable = targetError(
    "not-running",
    "No running applied database plan exists at the selected app root.",
    request.service,
  );
  const resolver = yield* UserAppResolver;
  const registry = yield* RuntimeProviderRegistry;
  const planner = yield* AppPlanner;
  const landofile = yield* resolver.load(request.root).pipe(mapFailures(() => rejected));
  const discovered = yield* registry.resolveAppliedPlan(request.root, undefined, "exact").pipe(
    mapFailures((error) => {
      switch (error._tag) {
        case "AppliedStateVersionError":
          return error;
        case "ProviderUnavailableError":
          return error.operation === "applied-state.read" ? error : rejected;
        default:
          return rejected;
      }
    }),
  );
  if (discovered === undefined) return yield* unavailable;
  const plan = yield* registry
    .readAppliedPlanStrict(discovered)
    .pipe(mapFailures((error) => (error._tag === "NoProviderInstalledError" ? rejected : error)));
  if (plan === undefined) return yield* unavailable;
  const identity = planAppIdentity(plan);
  if (
    plan.id !== discovered.id ||
    plan.provider !== discovered.provider ||
    landofile.context.appRoot !== request.root ||
    identity.appRoot !== request.root ||
    (landofile.document.provider !== undefined && landofile.document.provider !== plan.provider)
  )
    return yield* rejected;
  const provider = yield* registry.select(plan).pipe(mapFailures(() => rejected));
  const desiredPlan = yield* planner
    .plan(landofile, provider.capabilities, {
      kind: "user",
      ...(identity.dataName === undefined ? {} : { dataName: identity.dataName }),
    })
    .pipe(mapFailures(() => rejected));
  const candidates = Object.values(desiredPlan.services).filter(
    (service) => service.connection !== undefined,
  );
  const names = candidates.map((service) => service.name);
  if (request.service === undefined && candidates.length > 1)
    return yield* new SqlServiceAmbiguousError({
      message: "More than one database service is configured.",
      available: names,
      remediation: "Select the database with --service.",
    });
  const desiredService =
    request.service === undefined
      ? candidates[0]
      : candidates.find((service) => service.name === request.service);
  const desired = desiredService?.connection;
  if (desiredService === undefined || desired === undefined)
    return yield* new SqlServiceNotFoundError({
      message: "No matching server database service is configured.",
      available: names,
      remediation: "Select a configured server database with --service.",
      ...(request.service === undefined ? {} : { service: request.service }),
    });
  const service = plan.services[desiredService.name];
  const previous = service?.connection;
  if (service === undefined || previous === undefined) return yield* unavailable;
  const desiredImage = desiredService.artifact;
  if (desiredImage?.kind !== "ref") return yield* rejected;
  const desiredMount = yield* catalogDatabase({ plan: desiredPlan, service: desiredService }).pipe(
    mapFailures(() => rejected),
  );
  const appliedMount = yield* catalogDatabase({ plan, service, expectedSource: desiredImage }).pipe(
    mapFailures(() => rejected),
  );
  if (
    desiredMount === undefined ||
    appliedMount === undefined ||
    desiredMount.store !== appliedMount.store ||
    desiredMount.target !== appliedMount.target ||
    previous.family !== desired.family ||
    previous.port !== desired.port ||
    planDataId(desiredPlan) !== planDataId(plan) ||
    desiredPlan.provider !== plan.provider ||
    service.provider !== desiredService.provider ||
    !Equal.equals(service.entrypoint, desiredService.entrypoint) ||
    !Equal.equals(service.command, desiredService.command)
  )
    return yield* rejected;
  return { plan, service, provider, desired, previous };
});

const reconcile = Effect.fn("DatabaseCredentialConvergence.reconcile")(function* (
  request: DatabaseCredentialConvergenceRequest,
) {
  const target = yield* resolveTarget(request);
  const environment = yield* EnvironmentValueResolver;
  const session = yield* environment.openSession();
  const paths = yield* PathsService;
  const prepared = yield* prepareReconciliation({
    ...target,
    session,
    fallback: request,
    adminSeedRoot: paths.roots.userDataRoot,
  });
  if (!request.apply || prepared.preview.outcome === "already-matched") return prepared.preview;
  const changed = targetError(
    "target-changed",
    "The desired or applied database changed after preview.",
    target.service.name,
  );
  return yield* withAppMutationLock(
    target.plan,
    Effect.gen(function* () {
      const current = yield* resolveTarget(request);
      if (!Equal.equals(target.service, current.service) || !Equal.equals(target.desired, current.desired))
        return yield* changed;
      const updated = yield* prepared.apply;
      if (!Equal.equals(current.desired.creds, current.previous.creds))
        return { ...updated, next: "lando start" as const };
      if (
        [current.desired.creds.password, current.desired.creds.rootPassword].some(
          (value) => typeof value === "object",
        )
      )
        return { ...updated, next: "lando restart" as const };
      return updated;
    }),
  ).pipe(
    mapFailures((error) =>
      error._tag === "StateStoreError" || error._tag === "AppLockTimeoutError" ? changed : error,
    ),
  );
}, Effect.scoped);

export const layer = Layer.effect(
  DatabaseCredentialConvergence,
  Effect.gen(function* () {
    const context = yield* Effect.context<
      | AppPlanner
      | EnvironmentValueResolver
      | PathsService
      | PrivateFileAccessService
      | RedactionService
      | RuntimeProviderRegistry
      | StateStore
      | UserAppResolver
    >();
    return DatabaseCredentialConvergence.of({
      reconcile: (request) => reconcile(request).pipe(Effect.provide(context)),
    });
  }),
);
