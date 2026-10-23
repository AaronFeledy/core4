import type { AppPlan, LandofileShape } from "@lando/sdk/schema";
import { Predicate } from "effect";

import { collectSecretEnvValues } from "@lando/redaction/service";
import { isLandofileOverride, isLandofileReset } from "@lando/sdk/landofile";

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
    collected[key] = typeof value === "string" ? value : undefined;
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

export const collectAuthoredRedactionTokens = (document: unknown): readonly string[] => {
  if (isLandofileReset(document)) return [];
  if (isLandofileOverride(document)) return collectAuthoredRedactionTokens(document.value);
  if (Array.isArray(document))
    return document.flatMap((entry) => {
      if (typeof entry !== "string") return collectAuthoredRedactionTokens(entry);
      const equals = entry.indexOf("=");
      return equals < 0 ? [] : collectSecretEnvValues({ [entry.slice(0, equals)]: entry.slice(equals + 1) });
    });
  if (!Predicate.isObject(document)) return [];
  return Object.entries(document).flatMap(([key, value]) => [
    ...(typeof value === "string" ? collectSecretEnvValues({ [key]: value }) : []),
    ...collectAuthoredRedactionTokens(value),
  ]);
};
