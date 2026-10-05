import { Effect } from "effect";

import { ServiceFeatureError, ServiceTypeError } from "@lando/sdk/errors";
import type { HealthcheckPlan } from "@lando/sdk/schema";
import type {
  ServiceFeatureContext,
  ServiceFeatureDefinition,
  ServiceImageIdentity,
} from "@lando/sdk/services";

export const serviceFeatureApply =
  (
    featureId: string,
    fallbackMessage: string,
    apply: (ctx: ServiceFeatureContext) => void,
  ): ServiceFeatureDefinition["apply"] =>
  (ctx) =>
    Effect.try({
      try: () => apply(ctx),
      catch: (cause) =>
        new ServiceFeatureError({
          message: cause instanceof Error ? cause.message : fallbackMessage,
          feature: featureId,
          cause,
        }),
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
      }),
  });

export const addEnvRecord = (ctx: ServiceFeatureContext, env: Readonly<Record<string, string>>): void => {
  for (const [key, value] of Object.entries(env)) ctx.addEnv(key, value);
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

export const loopbackTcpHealthcheck = (port: number, startPeriodSeconds: number): HealthcheckPlan =>
  commandHealthcheck(["bash", "-c", `exec 3<>/dev/tcp/127.0.0.1/${port}`], startPeriodSeconds);

export const rootIdentity = (extraHomes: ServiceImageIdentity["homes"] = {}): ServiceImageIdentity => ({
  defaultUser: "root",
  homes: { root: "/root", ...extraHomes },
});
