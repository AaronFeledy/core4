import { RedactionService } from "@lando/redaction/service";
import { mapFailures } from "@lando/sdk/command-result";
import { ProviderCapabilityError, ServiceStartError } from "@lando/sdk/errors";
import { type AppPlan, type ServiceName, planDataId } from "@lando/sdk/schema";
import {
  type ApplyOptions,
  type ApplyResult,
  type EnvironmentValueResolverSession,
  PathsService,
  type RuntimeProviderShape,
  StateStore,
} from "@lando/sdk/services";
import { Clock, Effect, Option, Ref, Semaphore } from "effect";
import { catalogCandidate, catalogDatabase } from "../operations/database-convergence/catalog.ts";
import { targetError } from "../operations/database-convergence/target.ts";
import { connectionChanged } from "../operations/database-credentials.ts";
import {
  type CredentialAttempt,
  type CredentialFailure,
  attemptActivationCredential,
  boundCredentialAttempt,
  credentialBudgetMs,
} from "./activation-credential-attempt.ts";
import { observeUnmanagedCredentials, warning } from "./activation-credential-warnings.ts";
import { coordinatedServiceVolume } from "./volume-coordination.ts";

type HealthyContinuation = NonNullable<ApplyOptions["continueHealthyDependency"]>;
type HealthyDependency = Parameters<HealthyContinuation>[0];
type CredentialPhase =
  | { readonly kind: "inline"; readonly containerId: HealthyDependency["containerId"] }
  | { readonly kind: "residual" | "observe-only" };

const unprovenBuildDetail = "The database image's catalog provenance could not be verified.";

export const makeActivationCredentialWorker = Effect.fn("Activation.makeCredentialWorker")(function* (input: {
  readonly plan: AppPlan;
  readonly previousPlan?: AppPlan | undefined;
  readonly desiredPlan?: AppPlan | undefined;
  readonly complete?: boolean;
  readonly provider: RuntimeProviderShape;
  readonly session: EnvironmentValueResolverSession;
}) {
  const { plan, previousPlan, provider, session } = input;
  const budgets = Object.values(plan.services).flatMap(({ connection }) =>
    connection === undefined ? [] : [credentialBudgetMs(connection.family)],
  );
  if (budgets.length === 0) return undefined;
  const paths = yield* Effect.serviceOption(PathsService);
  const redaction = yield* Effect.serviceOption(RedactionService);
  const store = yield* StateStore;
  const retained = [input.desiredPlan, input.complete === true ? undefined : previousPlan].flatMap((view) =>
    view?.provider === plan.provider && planDataId(view) === planDataId(plan)
      ? Object.values(view.services).filter((service) => plan.services[service.name] === undefined)
      : [],
  );
  const unsupported =
    provider.healthyDependencyContinuation !== true
      ? "healthyDependencyContinuation"
      : !provider.capabilities.serviceExec
        ? "serviceExec"
        : provider.observeBoundVolume === undefined
          ? "observeBoundVolume"
          : undefined;
  const missing =
    unsupported ??
    (Option.isNone(paths) || Option.isNone(redaction) ? "credentialConvergenceContext" : undefined);
  if (missing !== undefined) {
    for (const consumer of Object.values(plan.services)) {
      for (const edge of consumer.dependsOn) {
        if (!edge.required || edge.condition !== "service_healthy") continue;
        const service = plan.services[edge.service];
        if (service === undefined || catalogCandidate({ plan, service, retained }) === undefined) continue;
        return yield* new ProviderCapabilityError({
          providerId: provider.id,
          operation: "database-credential-convergence",
          capability: missing,
          requiredValue: true,
          actualValue: false,
          message: `Cannot safely start ${consumer.name} behind database ${service.name}: credential convergence requires ${missing}.`,
          remediation:
            "Use a runtime and provider that support database credential convergence, then retry the same command with the same selection.",
        });
      }
    }
  }
  if (Option.isNone(paths) || Option.isNone(redaction)) return undefined;
  const adminSeedRoot = paths.value.roots.userDataRoot;
  const redactor = redaction.value;
  const seedWarningEmitted = yield* Ref.make(false);
  const onAdminSeedUnavailable = Ref.getAndSet(seedWarningEmitted, true).pipe(
    Effect.flatMap((emitted) =>
      emitted
        ? Effect.void
        : warning({
            code: "LANDO_DATABASE_ADMIN_SEED_UNAVAILABLE",
            message:
              "Could not read or initialize the private database administrator seed. Lando will try the previous or desired administrator credentials without adopting lando_admin.",
            remediation:
              "Check ownership and permissions on db-admin/key.v1 in your Lando data directory, or restore the original seed from backup. Do not replace an existing seed.",
          }),
    ),
  );

  const remaining = yield* Ref.make(Math.max(...budgets));
  const early = yield* Ref.make(
    new Map<ServiceName, { readonly containerId: string; readonly result: CredentialAttempt | undefined }>(),
  );
  // New early attempts share one active-work budget; intervening provider work does not spend it.
  const earlySlot = yield* Semaphore.make(1);
  const attempt = Effect.fnUntraced(function* (
    serviceName: ServiceName,
    createdVolumes: ApplyResult["createdVolumes"],
    phase: CredentialPhase,
  ) {
    const service = plan.services[serviceName];
    const desired = service?.connection;
    if (service === undefined || desired === undefined) return undefined;
    if (phase.kind === "inline" && catalogCandidate({ plan, service, retained }) === undefined)
      return undefined;
    return yield* boundCredentialAttempt({
      providerId: provider.id,
      budgetMs: Math.min(yield* Ref.get(remaining), credentialBudgetMs(desired.family)),
      work: Effect.fnUntraced(function* (onMutationDispatch) {
        const catalog =
          phase.kind === "observe-only"
            ? undefined
            : yield* catalogDatabase({ plan, service, retained }).pipe(
                mapFailures(() => targetError("unsupported-target", unprovenBuildDetail, service.name)),
              );
        if (catalog === undefined) {
          if (phase.kind === "inline") return { kind: "unproven-build" } satisfies CredentialAttempt;
          yield* observeUnmanagedCredentials({
            plan,
            provider,
            session,
            ...(previousPlan === undefined ? {} : { previousPlan }),
            services: [{ name: service.name, state: "running" }],
          });
          return undefined;
        }
        const previous = previousPlan?.services[serviceName]?.connection;
        const admission =
          phase.kind === "inline"
            ? {
                applying: {
                  containerId: phase.containerId,
                  volume: yield* coordinatedServiceVolume(plan, catalog.store),
                },
              }
            : {};
        return yield* attemptActivationCredential({
          plan,
          provider,
          session,
          service,
          desired,
          retained,
          onMutationDispatch,
          ...(previous?.family === desired.family ? { previous } : {}),
          ...admission,
          ...(createdVolumes === undefined ? {} : { createdVolumes }),
          adminSeedRoot,
          onAdminSeedUnavailable,
        });
      }),
    }).pipe(Effect.provideService(StateStore, store), Effect.provideService(RedactionService, redactor));
  });
  const runEarly = Effect.fnUntraced(function* (dependency: HealthyDependency) {
    const start = yield* Clock.monotonicTimeNanos;
    return yield* attempt(dependency.dependency, dependency.createdVolumes, {
      kind: "inline",
      containerId: dependency.containerId,
    }).pipe(
      Effect.ensuring(
        Effect.flatMap(Clock.monotonicTimeNanos, (end) =>
          Ref.update(remaining, (ms) => Math.max(0, ms - Number(end - start) / 1_000_000)),
        ),
      ),
    );
  });

  const remediation = (guidance?: string) =>
    [
      guidance,
      "Fix the database or its configuration, then retry the same command with the same selection.",
      "Do not delete the database volume.",
    ]
      .filter((line) => line !== undefined)
      .join(" ");
  const blocked = (input: HealthyDependency, failure: CredentialFailure) =>
    new ServiceStartError({
      providerId: provider.id,
      operation: "database-credential-convergence",
      service: input.consumer,
      details: { dependency: input.dependency, reason: failure.reason },
      message: `Service ${input.consumer} is waiting for database credentials for ${input.dependency}. ${failure.detail}`,
      remediation: remediation(failure.guidance),
    });

  const continueHealthyDependency: HealthyContinuation = (dependency) =>
    earlySlot.withPermit(
      Effect.gen(function* () {
        const entry = (yield* Ref.get(early)).get(dependency.dependency);
        if (entry !== undefined && entry.containerId !== dependency.containerId)
          return blocked(dependency, {
            reason: "target-changed",
            detail: "The database container changed during this activation.",
          });
        const result = entry === undefined ? yield* runEarly(dependency) : entry.result;
        if (entry === undefined)
          yield* Ref.update(early, (map) =>
            new Map(map).set(dependency.dependency, {
              containerId: dependency.containerId,
              result,
            }),
          );
        if (result?.kind === "unproven-build")
          return blocked(dependency, {
            reason: "unsupported-target",
            detail: unprovenBuildDetail,
          });
        return result?.kind === "failed" ? blocked(dependency, result.failure) : undefined;
      }),
    );

  const finish = Effect.fnUntraced(function* (applied: ApplyResult) {
    const attempted = yield* Ref.get(early);
    const results = yield* Effect.forEach(
      Object.values(plan.services),
      Effect.fnUntraced(function* (service) {
        const done = attempted.get(service.name)?.result;
        const action = applied.services?.[service.name]?.action;
        const previous = previousPlan?.services[service.name];
        const inResidualScope =
          done === undefined &&
          action !== undefined &&
          (action !== "kept" ||
            connectionChanged(previous, service) ||
            (previous === undefined && catalogCandidate({ plan, service, retained }) !== undefined));
        // Successful apply means any refusal for unproven build provenance was on an optional edge.
        const result =
          done?.kind === "unproven-build"
            ? yield* attempt(service.name, applied.createdVolumes, { kind: "observe-only" })
            : (done ??
              (inResidualScope
                ? yield* attempt(service.name, applied.createdVolumes, { kind: "residual" })
                : undefined));
        if (result?.kind === "failed" && service.connection !== undefined) {
          yield* warning({
            code: "LANDO_DATABASE_CREDENTIAL_CONVERGENCE_FAILED",
            message: `Could not converge database credentials for ${service.name}. ${result.failure.detail}`,
            remediation: remediation(result.failure.guidance),
            context: { service: service.name, family: service.connection.family },
          });
        }
        return result?.kind === "verified" ? result.change : undefined;
      }),
      { concurrency: "unbounded" },
    );
    return results.filter((change) => change !== undefined);
  });
  return { continueHealthyDependency, finish };
});
