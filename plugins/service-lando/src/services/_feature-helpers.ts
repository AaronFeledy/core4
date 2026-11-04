import { Effect } from "effect";

import { ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";
import type {
  EndpointPlan,
  Environment,
  EnvironmentValue,
  HealthcheckPlan,
  ServiceFeatureValidationResult,
  ValidationIssuePath,
} from "@lando/sdk/schema";
import type {
  ServiceEndpointContext,
  ServiceFeatureContext,
  ServiceFeatureDefinition,
  ServiceImageIdentity,
} from "@lando/sdk/services";

export class ServiceConfigIssue extends Error {
  constructor(
    readonly path: ValidationIssuePath,
    message: string,
    readonly suggestion?: string,
  ) {
    super(message);
    this.name = "ServiceConfigIssue";
  }
}

const featureError = (feature: string, cause: unknown, fallback: string) =>
  new ServiceFeatureError({
    feature,
    message: cause instanceof Error ? cause.message : fallback,
    cause,
    ...(cause instanceof ServiceConfigIssue
      ? {
          issues: [
            {
              path: cause.path,
              message: cause.message,
              ...(cause.suggestion === undefined ? {} : { suggestion: cause.suggestion }),
            },
          ],
        }
      : {}),
    remediation:
      cause instanceof ServiceConfigIssue && cause.suggestion !== undefined
        ? cause.suggestion
        : `Correct the ${feature} feature configuration in the Landofile, then re-run.`,
  });

export const serviceFeatureValidateEffective =
  (
    featureId: string,
    validate: (ctx: ServiceEndpointContext) => ServiceFeatureValidationResult,
  ): NonNullable<ServiceFeatureDefinition["validateEffective"]> =>
  (ctx) =>
    Effect.try({
      try: () => validate(ctx),
      catch: (cause) => {
        if (!(cause instanceof ServiceConfigIssue)) throw cause;
        return featureError(featureId, cause, "Effective service validation failed.");
      },
    });

export const serviceFeatureDeclareEndpoints =
  (
    featureId: string,
    declare: (ctx: ServiceEndpointContext) => readonly EndpointPlan[],
  ): NonNullable<ServiceFeatureDefinition["declareEndpoints"]> =>
  (ctx) =>
    Effect.try({
      try: () => declare(ctx),
      catch: (cause) => {
        if (!(cause instanceof ServiceConfigIssue)) throw cause;
        return featureError(featureId, cause, "Endpoint declaration failed.");
      },
    });

export const serviceFeatureApply =
  (
    featureId: string,
    fallbackMessage: string,
    apply: (ctx: ServiceFeatureContext) => void,
  ): ServiceFeatureDefinition["apply"] =>
  (ctx) =>
    Effect.try({
      try: () => apply(ctx),
      catch: (cause) => featureError(featureId, cause, fallbackMessage),
    });

export const serviceTypeResolve = <A>(
  serviceType: string,
  fallbackMessage: string,
  resolve: () => A,
): Effect.Effect<A, ServiceTypeError> =>
  Effect.try({
    try: resolve,
    catch: (cause) =>
      new ServiceTypeError({
        message: cause instanceof Error ? cause.message : fallbackMessage,
        serviceType,
        cause,
        ...(cause instanceof ServiceConfigIssue
          ? {
              issues: [
                {
                  path: cause.path,
                  message: cause.message,
                  ...(cause.suggestion ? { suggestion: cause.suggestion } : {}),
                },
              ],
            }
          : {}),
        remediation:
          cause instanceof ServiceConfigIssue && cause.suggestion
            ? cause.suggestion
            : `Correct the ${serviceType} service configuration in the Landofile (see the reported field path), then re-run.`,
      }),
  });

export const addEnvRecord = (ctx: ServiceFeatureContext, env: Environment): void => {
  for (const [key, value] of Object.entries(env)) ctx.addEnv(key, value);
};

export const literalEnvironmentValue = (value: EnvironmentValue, path: ValidationIssuePath): string => {
  if (typeof value !== "string") {
    throw new ServiceConfigIssue(
      path,
      "This setting requires literal text at plan time.",
      "Use a literal value rather than a secret binding.",
    );
  }
  return value;
};

export const commandHealthcheck = (
  command: NonNullable<HealthcheckPlan["command"]>,
  startPeriodSeconds: number,
  timing: Partial<Pick<HealthcheckPlan, "intervalSeconds" | "timeoutSeconds" | "retries">> = {},
): HealthcheckPlan => ({
  kind: "command",
  command,
  intervalSeconds: timing.intervalSeconds ?? 10,
  timeoutSeconds: timing.timeoutSeconds ?? 5,
  retries: timing.retries ?? 5,
  startPeriodSeconds,
});

export const rootIdentity = (extraHomes: ServiceImageIdentity["homes"] = {}): ServiceImageIdentity => ({
  defaultUser: "root",
  homes: { root: "/root", ...extraHomes },
});
