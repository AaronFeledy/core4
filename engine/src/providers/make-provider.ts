import { StartFailureLogRedactor } from "@lando/container-runtime/redact";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import {
  HealthcheckError,
  ProviderCapabilityError,
  ProviderUnavailableError,
  ServiceExecError,
} from "@lando/sdk/errors";
import type { LandoPluginContext, RuntimeProviderContribution } from "@lando/sdk/plugins";
import type { AppPlan } from "@lando/sdk/schema";
import type { Redactor } from "@lando/sdk/secrets";
import {
  AppPlanSanitizer,
  ContainerHelperAssets,
  Downloader,
  EventService,
  PathsService,
} from "@lando/sdk/services";
import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { type Context, Effect, type Option } from "effect";
import { collectAppPlanRedactionTokens } from "../services/app-plan-redaction.ts";
import {
  type HostProbeRunners,
  interruptOnAbort,
  prepareHealthcheckAttempt,
  validateHealthcheckExecution,
} from "../subsystems/healthcheck/attempt.ts";
import { withProviderErrorRedaction } from "./error-policy.ts";
import { redactProviderError } from "./error-redaction.ts";
import { withOutputRegistration } from "./output-policy.ts";
import { registerProviderOutput } from "./output-redaction.ts";

interface ProviderRuntimeContext {
  readonly hostProbeRunners?: HostProbeRunners;
  readonly paths: Context.Service.Shape<typeof PathsService>;
  readonly downloader: Context.Service.Shape<typeof Downloader>;
  readonly containerHelperAssets: Context.Service.Shape<typeof ContainerHelperAssets>;
  readonly appPlanSanitizer: Context.Service.Shape<typeof AppPlanSanitizer>;
  readonly eventService: Option.Option<Context.Service.Shape<typeof EventService>>;
  readonly redaction: Option.Option<Context.Service.Shape<typeof RedactionService>>;
  readonly privateFileAccess: PrivateFileAccess;
  readonly errorRedactor: Redactor;
}

export const makeProviderFactory = (services: ProviderRuntimeContext) => {
  const {
    paths,
    downloader,
    containerHelperAssets,
    appPlanSanitizer,
    eventService,
    redaction,
    privateFileAccess,
    errorRedactor,
  } = services;
  return (
    descriptor: { readonly contribution: RuntimeProviderContribution; readonly context: LandoPluginContext },
    desired?: AppPlan,
  ) => {
    const { contribution, context } = descriptor;
    const provider = contribution.make(context).pipe(
      Effect.provideService(PathsService, paths),
      Effect.provideService(Downloader, downloader),
      Effect.provideService(ContainerHelperAssets, containerHelperAssets),
      Effect.provideService(AppPlanSanitizer, appPlanSanitizer),
      Effect.map((runtime) =>
        withProviderErrorRedaction(
          {
            ...withOutputRegistration(runtime, (target) => {
              if (redaction._tag === "None")
                return Effect.fail(
                  new ProviderUnavailableError({
                    providerId: runtime.id,
                    operation: "registerOutput",
                    message: "Output redaction is unavailable.",
                    remediation: "Provide RedactionService when constructing the runtime provider registry.",
                  }),
                );
              const selected =
                target.plan === undefined && desired?.id === target.app
                  ? { ...target, plan: desired }
                  : target;
              return contribution.appliedPlans(context).pipe(
                Effect.flatMap((appliedPlans) =>
                  registerProviderOutput({ target: selected, provider: runtime, appliedPlans }),
                ),
                Effect.provideService(PathsService, paths),
                Effect.provideService(PrivateFileAccessService, privateFileAccess),
                Effect.provideService(RedactionService, redaction.value),
              );
            }),
            apply: Effect.fnUntraced(function* (plan, options) {
              yield* validateHealthcheckExecution(plan, services.hostProbeRunners ?? {});
              const tokens = [...collectAppPlanRedactionTokens(plan)];
              const redactorOptions = { sourceEnv: { ...process.env }, redactionTokens: tokens };
              const redactor =
                redaction._tag === "Some"
                  ? yield* redaction.value
                      .registerValues(tokens)
                      .pipe(Effect.andThen(redaction.value.forProfile("secrets", redactorOptions)))
                  : createStandaloneRedactor("secrets", redactorOptions);
              return yield* runtime
                .apply(plan, {
                  ...options,
                  executeReadinessAttempt: (service, probe) =>
                    interruptOnAbort(
                      prepareHealthcheckAttempt({
                        probe,
                        service,
                        app: plan.id,
                        plan,
                        exec: runtime.exec,
                        ...(services.hostProbeRunners === undefined
                          ? {}
                          : { runners: services.hostProbeRunners }),
                        ...(options.signal === undefined ? {} : { signal: options.signal }),
                      }).pipe(
                        Effect.mapError((error) =>
                          error instanceof HealthcheckError
                            ? new ServiceExecError({
                                providerId: runtime.id,
                                service: String(service),
                                operation: "readiness",
                                message: error.message,
                                remediation: error.remediation,
                              })
                            : error,
                        ),
                        Effect.flatMap((attempt) => attempt.run),
                      ),
                      options.signal,
                    ),
                })
                .pipe(Effect.provideService(StartFailureLogRedactor, redactor));
            }),
          },
          errorRedactor,
        ),
      ),
      Effect.mapError((cause) =>
        redactProviderError(
          cause instanceof ProviderCapabilityError
            ? new ProviderUnavailableError({
                providerId: cause.providerId,
                operation: cause.operation,
                message: cause.message,
                ...(cause.details === undefined ? {} : { details: cause.details }),
                remediation: cause.remediation,
                cause,
              })
            : cause,
          errorRedactor,
        ),
      ),
    );
    return eventService._tag === "Some"
      ? provider.pipe(Effect.provideService(EventService, eventService.value))
      : provider;
  };
};
