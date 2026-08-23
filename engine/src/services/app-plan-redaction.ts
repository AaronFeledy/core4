import type { AppPlan, LandofileShape } from "@lando/sdk/schema";

import { collectSecretEnvValues } from "@lando/redaction/service";

type EnvMap = Readonly<Record<string, unknown>> | undefined;

type ServiceEnvSource = {
  readonly environment?: EnvMap;
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
  Object.values(plan.services).flatMap((service) => collectSecretEnvValues(stringEnv(service?.environment)));

export const collectLandofileRedactionTokens = (
  landofile: LandofileTokenSource | LandofileShape,
): ReadonlyArray<string> => {
  const serviceTokens = Object.values(landofile.services ?? {}).flatMap((service) =>
    collectSecretEnvValues(stringEnv(service?.environment)),
  );
  const toolingTokens = Object.values(landofile.tooling ?? {}).flatMap((task) =>
    collectSecretEnvValues(stringEnv(task?.env)),
  );
  return [
    ...serviceTokens,
    ...toolingTokens,
    ...collectSecretEnvValues(stringEnv(landofile.toolingDefaults?.env)),
  ];
};
