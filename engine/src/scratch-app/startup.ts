import { AppPlacementError, ScratchAppError, ServiceNotReadyError } from "@lando/sdk/errors";
import type { AbsolutePath, AppPlan, RouterConfig } from "@lando/sdk/schema";
import {
  EnvironmentValueResolver,
  type FileSystem,
  type RouterServiceShape,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { Cause, type Context, Effect, Exit } from "effect";
import { completeStartup } from "../lifecycle/startup-completion.ts";
import { volumeCreationRecorder } from "../lifecycle/volume-initialization.ts";
import {
  type GlobalConsumerAdmissionServices,
  requiresGlobalConsumerAdmission,
  withGlobalConsumerAdmission,
} from "../operations/global-consumer-admission.ts";
import { verifyGlobalConsumerAdmission } from "../operations/global-consumer-lease.ts";
import { applyWithResolvedEnvironment } from "../services/apply-environment.ts";
import { applyDebuggerHost, resolveDebuggerHost } from "../subsystems/debugger-host.ts";
import type { makeScratchReaper } from "./destroy.ts";
import type { ScratchRegistry } from "./registry.ts";

export const applyScratchStartup = Effect.fn("ScratchApp.applyStartup")(function* (
  request: {
    readonly id: string;
    readonly plan: AppPlan;
    readonly landofileRouter?: RouterConfig;
    readonly resolvedDebuggerHost?: { readonly address: string | undefined };
  },
  services: {
    readonly provider: RuntimeProviderShape;
    readonly environmentResolver: typeof EnvironmentValueResolver.Service;
    readonly router?: RouterServiceShape;
    readonly admissionContext?: Context.Context<GlobalConsumerAdmissionServices>;
  },
) {
  const { id, plan } = request;
  const debuggerHost =
    request.resolvedDebuggerHost === undefined
      ? yield* resolveDebuggerHost(plan)
      : request.resolvedDebuggerHost.address;
  const runtimePlan = applyDebuggerHost(plan, debuggerHost);
  const activate = Effect.gen(function* () {
    yield* Effect.scoped(
      applyWithResolvedEnvironment(
        services.provider,
        runtimePlan,
        {
          reconcile: false,
          onVolumeCreated: yield* volumeCreationRecorder(services.provider, runtimePlan),
        },
        verifyGlobalConsumerAdmission,
      ).pipe(Effect.provideService(EnvironmentValueResolver, services.environmentResolver)),
    ).pipe(
      Effect.mapError(
        (cause) =>
          new ScratchAppError({
            operation: "start",
            message: `Unable to start scratch app ${id}.`,
            cause,
            remediation: "Run `lando doctor`, fix the provider failure, then retry scratch start.",
          }),
      ),
    );
    yield* completeStartup({
      policy: "scratch",
      provider: services.provider,
      plan: runtimePlan,
      services: Object.values(runtimePlan.services).map((service) => service.name),
      ...(services.router === undefined ? {} : { router: services.router }),
      ...(request.landofileRouter === undefined ? {} : { landofileRouter: request.landofileRouter }),
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof AppPlacementError
          ? cause
          : new ScratchAppError({
              operation: "start",
              message: `Unable to ready scratch app ${id}.`,
              cause,
              remediation: "Wait for services to become healthy, or run `lando doctor` and retry.",
            }),
      ),
    );
  });
  if (!requiresGlobalConsumerAdmission(plan)) return yield* activate;
  if (services.admissionContext === undefined)
    return yield* Effect.fail(
      new ScratchAppError({
        operation: "start",
        message: `Global service admission is unavailable for scratch app ${id}.`,
        remediation:
          "Provide the global runtime services when constructing ScratchAppService before starting dependent scratch applications.",
      }),
    );
  return yield* withGlobalConsumerAdmission(
    {
      plan,
      ...(request.landofileRouter === undefined ? {} : { landofileRouter: request.landofileRouter }),
    },
    activate,
  ).pipe(
    Effect.provide(services.admissionContext),
    Effect.mapError((cause) =>
      cause instanceof AppPlacementError || cause instanceof ScratchAppError
        ? cause
        : new ScratchAppError({
            operation: "start",
            message: `Required global services could not be admitted for scratch app ${id}.`,
            cause,
            remediation:
              "Inspect global service policy and restore the required services before retrying scratch startup.",
          }),
    ),
  );
});

/** Transfer acquisition ownership to the successful scope without an interruptible gap. */
export const withScratchAcquisition = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  request: {
    readonly id: string;
    readonly plan: AppPlan;
    readonly instanceRoot: AbsolutePath;
    readonly keepOnFailure: boolean;
    readonly detached: boolean;
  },
  services: {
    readonly registry: typeof ScratchRegistry.Service;
    readonly fileSystem: typeof FileSystem.Service;
    readonly reap: Effect.Success<typeof makeScratchReaper>;
    readonly retainedIds: ReadonlySet<string>;
  },
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const { id, plan, instanceRoot } = request;
      // Only the task-owned instance root is reaped, never the possibly shared source plan.root.
      const cleanup = (reason: "scope-close" | "acquire-failure") =>
        services
          .reap({ id, plan, instanceRoot, reason })
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning(`Unable to reap scratch app ${id} during cleanup: ${Cause.pretty(cause)}`),
            ),
          );
      const result = yield* restore(effect).pipe(
        Effect.mapError((error) => {
          if (!(error instanceof ScratchAppError) || !(error.cause instanceof ServiceNotReadyError))
            return error;
          return new ScratchAppError({
            operation: error.operation,
            message: `${error.message} ${error.cause.message}`,
            remediation: request.keepOnFailure
              ? (error.cause.remediation ??
                "Inspect the retained scratch instance, fix the source Landofile, then retry.")
              : "Correct the source Landofile and retry scratch acquisition. Use --keep-on-failure to retain a failing instance for inspection.",
            cause: error.cause,
          });
        }),
        Effect.onExit((exit) =>
          Exit.isFailure(exit) && !request.keepOnFailure ? cleanup("acquire-failure") : Effect.void,
        ),
      );
      if (!request.detached) {
        yield* Effect.addFinalizer(() =>
          services.registry.get(id).pipe(
            Effect.catch(() => Effect.succeed(undefined)),
            Effect.flatMap((entry) =>
              entry !== undefined
                ? Effect.succeed(!entry.detached)
                : services.fileSystem.exists(instanceRoot).pipe(Effect.catch(() => Effect.succeed(true))),
            ),
            Effect.flatMap((owned) =>
              owned && !services.retainedIds.has(id) ? cleanup("scope-close") : Effect.void,
            ),
          ),
        );
      }
      return result;
    }),
  );
