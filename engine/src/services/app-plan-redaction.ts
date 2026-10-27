import type { AppPlan, EnvironmentValue, LandofileShape } from "@lando/sdk/schema";
import { Predicate } from "effect";

import {
  collectPublicCredentialValues,
  collectSecretEnvValues,
  collectSecretStructuralValues,
} from "@lando/redaction/service";
import { isLandofileOverride, isLandofileReset } from "@lando/sdk/landofile";

type EnvMap = Readonly<Record<string, unknown>> | undefined;

type ServiceEnvSource = {
  readonly environment?: EnvMap;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly password?: EnvironmentValue;
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
    collected[key] = typeof value === "string" ? value : undefined;
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
      ...collectSecretStructuralValues(stringEnv(service?.creds), publicValues),
      ...collectSecretStructuralValues(
        typeof service?.password === "string" ? { password: service.password } : undefined,
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
      return;
    }
    if (!Predicate.isObject(node)) return;
    // A service node carries its authored `creds` block beside its environment.
    const authoredCreds = isLandofileOverride(node.creds) ? node.creds.value : node.creds;
    const creds = Predicate.isObject(authoredCreds) ? authoredCreds : undefined;
    for (const value of collectPublicCredentialValues(node, creds)) publicValues.add(value);
    for (const value of Object.values(node)) discover(value);
  };
  discover(document);
  const isEnvMap = (path: readonly string[]): boolean =>
    (path.length === 1 && (path[0] === "appEnv" || path[0] === "appLabels")) ||
    (path.length === 2 && path[0] === "toolingDefaults" && path[1] === "env") ||
    (path.length === 3 && path[0] === "tooling" && path[2] === "env") ||
    (path[0] === "services" &&
      ((path.length === 3 && (path[2] === "environment" || path[2] === "labels")) ||
        (path.length === 5 && path[2] === "extensions" && path[3] === "compose" && path[4] === "labels")));
  const collect = (node: unknown, path: readonly string[]): readonly string[] => {
    if (isLandofileReset(node)) return [];
    if (isLandofileOverride(node)) return collect(node.value, path);
    if (typeof node === "string") {
      const key = path.at(-1);
      const collectValues = isEnvMap(path.slice(0, -1))
        ? collectSecretEnvValues
        : collectSecretStructuralValues;
      return key === undefined ? [] : collectValues({ [key]: node }, publicValues);
    }
    if (Array.isArray(node))
      return node.flatMap((entry) => {
        if (!isEnvMap(path) || typeof entry !== "string") return collect(entry, [...path, ""]);
        const equals = entry.indexOf("=");
        return equals < 0
          ? []
          : collectSecretEnvValues({ [entry.slice(0, equals)]: entry.slice(equals + 1) }, publicValues);
      });
    if (!Predicate.isObject(node)) return [];
    return Object.entries(node).flatMap(([key, value]) => collect(value, [...path, key]));
  };
  return collect(document, []);
};
