import type { AppPlan, LandofileShape } from "@lando/sdk/schema";
import { Predicate } from "effect";

import { collectPublicCredentialValues, collectSecretEnvValues } from "@lando/redaction/service";
import { isLandofileOverride, isLandofileReset } from "@lando/sdk/landofile";

type EnvMap = Readonly<Record<string, unknown>> | undefined;

type ServiceEnvSource = {
  readonly environment?: EnvMap;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly password?: string;
  readonly labels?: EnvMap;
  readonly creds?: Readonly<Record<string, unknown>>;
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

export const collectAppPlanPublicCredentialValues = (plan: {
  readonly services?: Readonly<Record<string, ServiceEnvSource | undefined>>;
}): ReadonlySet<string> =>
  new Set(
    Object.values(plan.services ?? {}).flatMap((service) => [
      ...collectPublicCredentialValues(service?.environment, service?.creds),
    ]),
  );

export const collectAppPlanRedactionTokens = (
  plan: Pick<AppPlan, "services"> | { readonly services: Readonly<Record<string, ServiceEnvSource>> },
): ReadonlyArray<string> => {
  const publicValues = collectAppPlanPublicCredentialValues(plan);
  return Object.values(plan.services).flatMap((service) => {
    const compose = service?.extensions?.compose;
    const labels =
      Predicate.isObject(compose) && Predicate.isObject(compose.labels) ? compose.labels : undefined;
    return [
      ...collectSecretEnvValues(stringEnv(service?.environment), publicValues),
      ...collectSecretEnvValues(stringEnv(service?.creds), publicValues),
      ...collectSecretEnvValues(stringEnv(labels), publicValues),
    ];
  });
};

export const collectLandofileRedactionTokens = (
  landofile: LandofileTokenSource | LandofileShape,
): ReadonlyArray<string> => {
  const publicValues = collectAppPlanPublicCredentialValues(landofile);
  const serviceTokens = Object.values(landofile.services ?? {}).flatMap((service) => {
    const compose = service?.extensions?.compose;
    const composeLabels =
      Predicate.isObject(compose) && Predicate.isObject(compose.labels) ? compose.labels : undefined;
    return [
      ...collectSecretEnvValues(stringEnv(service?.environment), publicValues),
      ...collectSecretEnvValues(stringEnv(service?.creds), publicValues),
      ...collectSecretEnvValues(
        service?.password === undefined ? undefined : { password: service.password },
        publicValues,
      ),
      ...collectSecretEnvValues(stringEnv(service?.labels), publicValues),
      ...collectSecretEnvValues(stringEnv(composeLabels), publicValues),
    ];
  });
  const toolingTokens = Object.values(landofile.tooling ?? {}).flatMap((task) =>
    collectSecretEnvValues(stringEnv(task?.env), publicValues),
  );
  return [
    ...serviceTokens,
    ...toolingTokens,
    ...collectSecretEnvValues(stringEnv(landofile.toolingDefaults?.env), publicValues),
  ];
};

export const collectAuthoredRedactionTokens = (document: unknown): readonly string[] => {
  const publicValues = new Set<string>();
  const discover = (node: unknown): void => {
    if (isLandofileReset(node)) return;
    if (isLandofileOverride(node)) {
      discover(node.value);
      return;
    }
    if (Array.isArray(node)) {
      const env = Object.fromEntries(
        node.flatMap((entry) => {
          if (typeof entry !== "string") return [];
          const equals = entry.indexOf("=");
          return equals < 0 ? [] : [[entry.slice(0, equals), entry.slice(equals + 1)]];
        }),
      );
      for (const value of collectPublicCredentialValues(env)) publicValues.add(value);
      for (const entry of node) discover(entry);
    } else if (Predicate.isObject(node)) {
      // A service node carries its authored `creds` block beside its environment.
      const authoredCreds = isLandofileOverride(node.creds) ? node.creds.value : node.creds;
      const creds = Predicate.isObject(authoredCreds) ? authoredCreds : undefined;
      for (const value of collectPublicCredentialValues(node, creds)) publicValues.add(value);
      for (const value of Object.values(node)) discover(value);
    }
  };
  discover(document);
  const collect = (node: unknown): readonly string[] => {
    if (isLandofileReset(node)) return [];
    if (isLandofileOverride(node)) return collect(node.value);
    if (Array.isArray(node))
      return node.flatMap((entry) => {
        if (typeof entry !== "string") return collect(entry);
        const equals = entry.indexOf("=");
        return equals < 0
          ? []
          : collectSecretEnvValues({ [entry.slice(0, equals)]: entry.slice(equals + 1) }, publicValues);
      });
    if (!Predicate.isObject(node)) return [];
    return Object.entries(node).flatMap(([key, value]) => [
      ...(typeof value === "string" ? collectSecretEnvValues({ [key]: value }, publicValues) : []),
      ...collect(value),
    ]);
  };
  return collect(document);
};
