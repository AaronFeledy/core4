import { RedactionService } from "@lando/redaction/service";
import { mapFailures } from "@lando/sdk/command-result";
import { ProviderCapabilityError } from "@lando/sdk/errors";
import { type AppPlan, type ServiceName, planDataId } from "@lando/sdk/schema";
import {
  type ApplyResult,
  type EnvironmentValueResolverSession,
  PathsService,
  type RuntimeProviderShape,
  StateStore,
} from "@lando/sdk/services";
import { Clock, Effect, Option, Ref, Semaphore } from "effect";
import { catalogDatabase } from "../operations/database-convergence/catalog.ts";
import { targetError } from "../operations/database-convergence/target.ts";
import {
  attemptActivationCredential,
  boundCredentialAttempt,
  credentialBudgetMs,
} from "./activation-credential-attempt.ts";
import {
  type CredentialAttempt,
  type DatabaseTarget,
  type HealthyContinuation,
  activationDatabaseTargets,
  credentialGateError,
  credentialGateFailure,
  credentialRecovery,
  credentialWorkAfterApply,
  unprovenBuildDetail,
} from "./activation-credential-policy.ts";
import { observeUnmanagedCredentials, warning } from "./activation-credential-warnings.ts";
import { coordinatedServiceVolume } from "./volume-coordination.ts";

type CredentialPhase =
  | { readonly kind: "inline"; readonly containerId: string }
  | { readonly kind: "residual" | "observe-only" };

export const makeActivationCredentialWorker = Effect.fn("Activation.makeCredentialWorker")(function* (input: {
  readonly plan: AppPlan;
  readonly previousPlan?: AppPlan | undefined;
  readonly desiredPlan?: AppPlan | undefined;
  readonly complete?: boolean;
  readonly provider: RuntimeProviderShape;
  readonly session: EnvironmentValueResolverSession;
}) {
  const { plan, previousPlan, provider, session } = input;
  const retained = [input.desiredPlan, input.complete === true ? undefined : previousPlan].flatMap((view) =>
    view?.provider === plan.provider && planDataId(view) === planDataId(plan)
      ? Object.values(view.services).filter((service) => plan.services[service.name] === undefined)
      : [],
  );
  const targets = activationDatabaseTargets(plan, retained);
  if (targets.size === 0) return undefined;
  const paths = yield* Effect.serviceOption(PathsService);
  const redaction = yield* Effect.serviceOption(RedactionService);
  const store = yield* StateStore;
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
        const target = targets.get(edge.service);
        if (target === undefined || !target.isCatalogCandidate()) continue;
        return yield* new ProviderCapabilityError({
          providerId: provider.id,
          operation: "database-credential-convergence",
          capability: missing,
          requiredValue: true,
          actualValue: false,
          details: { service: consumer.name, dependency: target.service.name },
          message: `Cannot start ${consumer.name}: preparing credentials for database ${target.service.name} requires ${missing}.`,
          remediation:
            missing === "credentialConvergenceContext"
              ? "Supply PathsService and RedactionService in the activation context, then retry the same command with the same selection."
              : "Use a runtime and provider that support database credential convergence, then retry the same command with the same selection.",
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

  let budgetMs = 0;
  for (const { connection } of targets.values()) {
    budgetMs = Math.max(budgetMs, credentialBudgetMs(connection.family));
  }
  const remaining = yield* Ref.make(budgetMs);
  const early = yield* Ref.make(
    new Map<ServiceName, { readonly containerId: string; readonly result: CredentialAttempt | undefined }>(),
  );
  // New early attempts share one active-work budget; intervening provider work does not spend it.
  const earlySlot = yield* Semaphore.make(1);
  const attempt = Effect.fnUntraced(function* (
    { service, connection: desired }: DatabaseTarget,
    createdVolumes: ApplyResult["createdVolumes"],
    phase: CredentialPhase,
  ) {
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
        const previous = previousPlan?.services[service.name]?.connection;
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
  const continueHealthyDependency: HealthyContinuation = (dependency) =>
    earlySlot.withPermit(
      Effect.gen(function* () {
        const entry = (yield* Ref.get(early)).get(dependency.dependency);
        let result: CredentialAttempt | undefined;
        if (entry === undefined) {
          const target = targets.get(dependency.dependency);
          if (target === undefined || !target.isCatalogCandidate()) return undefined;
          const start = yield* Clock.monotonicTimeNanos;
          result = yield* attempt(target, dependency.createdVolumes, {
            kind: "inline",
            containerId: dependency.containerId,
          }).pipe(
            Effect.ensuring(
              Effect.flatMap(Clock.monotonicTimeNanos, (end) =>
                Ref.update(remaining, (ms) => Math.max(0, ms - Number(end - start) / 1_000_000)),
              ),
            ),
          );
          yield* Ref.update(early, (map) =>
            new Map(map).set(dependency.dependency, {
              containerId: dependency.containerId,
              result,
            }),
          );
        } else {
          if (entry.containerId !== dependency.containerId)
            return credentialGateError(provider.id, dependency, {
              reason: "target-changed",
              detail: "The database container changed during this activation.",
            });
          result = entry.result;
        }
        const failure = credentialGateFailure(result);
        return failure === undefined ? undefined : credentialGateError(provider.id, dependency, failure);
      }),
    );

  const finish = Effect.fnUntraced(function* (applied: ApplyResult) {
    const attempted = yield* Ref.get(early);
    const results = yield* Effect.forEach(
      targets.values(),
      Effect.fnUntraced(function* (target) {
        const { service, connection } = target;
        const done = attempted.get(service.name)?.result;
        const work = credentialWorkAfterApply(target, {
          action: applied.services?.[service.name]?.action,
          previous: previousPlan?.services[service.name],
          attempted: done,
        });
        const result =
          work === "skip"
            ? done
            : yield* attempt(target, applied.createdVolumes, {
                kind: work === "observe" ? "observe-only" : "residual",
              });
        if (result?.kind === "failed") {
          const { detail, reason, mutation } = result.failure;
          yield* warning({
            code: "LANDO_DATABASE_CREDENTIAL_CONVERGENCE_FAILED",
            message: `Could not verify or apply database credentials for ${service.name}. ${detail}`,
            remediation: credentialRecovery(result.failure),
            context: {
              service: service.name,
              family: connection.family,
              reason,
              ...(mutation === undefined ? {} : { mutation }),
            },
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
