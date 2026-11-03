import { sha256Hex } from "@lando/sdk/digest";
import { type AppPlan, EnvironmentValue, type ServicePlan } from "@lando/sdk/schema";
import {
  isPublicDefaultCredential,
  isSecretEnvName,
  isSecretStructuralName,
  isUsableExactRedactionValue,
} from "@lando/sdk/secrets";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { collectPublicCredentialValues, nonEmpty } from "./heuristic-values.ts";

type Candidate = {
  readonly path: ReadonlyArray<string | number>;
  readonly value: EnvironmentValue;
};

export type RedactionPlan = Partial<Pick<AppPlan, "committedLiteralDigests" | "events" | "extensions">> & {
  readonly services: Readonly<
    Record<string, Pick<ServicePlan, "environment" | "extensions" | "connection" | "nonSqlCreds">>
  >;
};

function* sensitiveMap(
  value: unknown,
  path: Candidate["path"],
  recognizes: (key: string) => boolean = isSecretEnvName,
): Generator<Candidate> {
  if (!Predicate.isObject(value)) return;
  for (const [key, leaf] of Object.entries(value)) {
    if (recognizes(key) && Schema.is(EnvironmentValue)(leaf)) {
      yield { path: [...path, key], value: leaf };
    }
  }
}

/** The single occurrence inventory shared by the planner and the redaction reader. */
export function* sensitivePlanCandidates(plan: RedactionPlan): Generator<Candidate> {
  for (const [name, service] of Object.entries(plan.services)) {
    const path = ["services", name];
    yield* sensitiveMap(service.environment, [...path, "environment"]);
    yield* sensitiveMap(Reflect.get(service, "labels"), [...path, "labels"]);
    const compose = service.extensions.compose;
    if (Predicate.isObject(compose)) {
      yield* sensitiveMap(compose.labels, [...path, "extensions", "compose", "labels"]);
    }
    if (service.connection !== undefined) {
      yield* sensitiveMap(service.connection.creds, [...path, "connection", "creds"], isSecretStructuralName);
    }
    yield* sensitiveMap(service.nonSqlCreds, [...path, "nonSqlCreds"], isSecretStructuralName);
  }
  const toolingKey = "@lando/core/effective-tooling";
  const tooling = plan.extensions?.[toolingKey];
  if (Predicate.isObject(tooling) && Predicate.isObject(tooling.tasks)) {
    for (const [name, task] of Object.entries(tooling.tasks)) {
      if (!Predicate.isObject(task)) continue;
      const path = ["extensions", toolingKey, "tasks", name];
      yield* sensitiveMap(task.env, [...path, "env"]);
      if (Array.isArray(task.cmds)) {
        for (const [index, step] of task.cmds.entries()) {
          if (Predicate.isObject(step)) yield* sensitiveMap(step.env, [...path, "cmds", index, "env"]);
        }
      }
    }
  }
  for (const [name, steps] of Object.entries(plan.events ?? {})) {
    for (const [index, entry] of steps.entries()) {
      if (typeof entry.step !== "string" && "env" in entry.step) {
        yield* sensitiveMap(entry.step.env, ["events", name, index, "step", "env"]);
      }
    }
  }
}

/** Recompute public identities from current values, never from retained authorizations. */
export const planRedactionValues = (
  plan: RedactionPlan,
): {
  readonly substring: readonly string[];
  readonly wholeToken: readonly string[];
  readonly wholeTokenValues: ReadonlySet<string>;
  readonly publicValues: ReadonlySet<string>;
} => {
  const publicValues = publicValuesForPlan(plan);
  const substring = new Set<string>();
  const wholeToken = new Set<string>();
  const digests = new Set(plan.committedLiteralDigests ?? []);
  const seen = new Set<string>();
  for (const { value } of sensitivePlanCandidates(plan)) {
    if (typeof value !== "string" || seen.has(value)) continue;
    seen.add(value);
    if (isPublicDefaultCredential(value)) publicValues.add(value);
    if (publicValues.has(value) || !isUsableExactRedactionValue(value)) continue;
    if (digests.has(sha256Hex(value))) wholeToken.add(value);
    else substring.add(value);
  }
  return {
    substring: [...substring],
    wholeToken: [...wholeToken],
    wholeTokenValues: wholeToken,
    publicValues,
  };
};

const publicValuesForPlan = (plan: RedactionPlan): Set<string> => {
  const publicValues = new Set<string>();
  for (const service of Object.values(plan.services)) {
    for (const value of collectPublicCredentialValues(
      service.environment,
      service.connection?.creds ?? service.nonSqlCreds,
    ))
      publicValues.add(value);
  }
  return publicValues;
};

/** Committed bytes retain whole-token matching under any secret-named key. */
export const classifyLoweredEnvRedaction = (
  env: Readonly<Record<string, string | undefined>> | undefined,
  options?: {
    readonly wholeToken?: ReadonlySet<string>;
    readonly publicValues?: ReadonlySet<string>;
  },
): {
  readonly substring: readonly string[];
  readonly wholeToken: readonly string[];
} => {
  if (env === undefined) return { substring: [], wholeToken: [] };
  const publicValues = new Set(options?.publicValues ?? []);
  for (const value of collectPublicCredentialValues(env)) publicValues.add(value);
  const substring = new Set<string>();
  const wholeToken = new Set<string>();
  for (const [key, value] of Object.entries(env)) {
    if (!isSecretEnvName(key) || !nonEmpty(value) || !isUsableExactRedactionValue(value)) continue;
    if (isPublicDefaultCredential(value) || publicValues.has(value)) continue;
    if (options?.wholeToken?.has(value)) wholeToken.add(value);
    else substring.add(value);
  }
  return {
    substring: [...substring],
    wholeToken: [...wholeToken],
  };
};
