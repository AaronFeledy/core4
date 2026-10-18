import type { AppPlan, LandofileShape } from "@lando/sdk/schema";
import { Effect, Option, Predicate } from "effect";

import { RedactionService, collectSecretEnvValues } from "@lando/redaction/service";

type EnvMap = Readonly<Record<string, unknown>> | undefined;

type ServiceEnvSource = {
  readonly environment?: EnvMap;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly password?: string;
  readonly labels?: EnvMap;
};

type LandofileTokenSource = {
  readonly services?: Readonly<Record<string, ServiceEnvSource | undefined>>;
  readonly tooling?: Readonly<Record<string, { readonly env?: EnvMap } | undefined>>;
  readonly toolingDefaults?: { readonly env?: EnvMap };
};

const stringEnv = (env: EnvMap): Record<string, string | undefined> | undefined => {
  if (env === undefined) return undefined;
  const collected: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    collected[key] = value === undefined || value === null ? undefined : String(value);
  }
  return collected;
};

export const collectAppPlanRedactionTokens = (
  plan: Pick<AppPlan, "services"> | { readonly services: Readonly<Record<string, ServiceEnvSource>> },
): ReadonlyArray<string> =>
  Object.values(plan.services).flatMap((service) => {
    const compose = service?.extensions?.compose;
    const labels =
      Predicate.isObject(compose) && Predicate.isObject(compose.labels) ? compose.labels : undefined;
    return [
      ...collectSecretEnvValues(stringEnv(service?.environment)),
      ...collectSecretEnvValues(stringEnv(labels)),
    ];
  });

/** Registered plan secrets reach generation-aware redactors already built by stream sinks. */
export const registerAppPlanRedactionTokens = Effect.fnUntraced(function* (
  plan: AppPlan,
): Effect.fn.Return<void> {
  const redaction = yield* Effect.serviceOption(RedactionService);
  yield* Option.match(redaction, {
    onNone: () => Effect.void,
    onSome: (service) => service.registerValues(collectAppPlanRedactionTokens(plan)),
  });
});

export const collectLandofileRedactionTokens = (
  landofile: LandofileTokenSource | LandofileShape,
): ReadonlyArray<string> => {
  const serviceTokens = Object.values(landofile.services ?? {}).flatMap((service) => {
    const compose = service?.extensions?.compose;
    const composeLabels =
      Predicate.isObject(compose) && Predicate.isObject(compose.labels) ? compose.labels : undefined;
    return [
      ...collectSecretEnvValues(stringEnv(service?.environment)),
      ...collectSecretEnvValues(service?.password === undefined ? undefined : { password: service.password }),
      ...collectSecretEnvValues(stringEnv(service?.labels)),
      ...collectSecretEnvValues(stringEnv(composeLabels)),
    ];
  });
  const toolingTokens = Object.values(landofile.tooling ?? {}).flatMap((task) =>
    collectSecretEnvValues(stringEnv(task?.env)),
  );
  return [
    ...serviceTokens,
    ...toolingTokens,
    ...collectSecretEnvValues(stringEnv(landofile.toolingDefaults?.env)),
  ];
};
