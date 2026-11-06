import { planRedactionValues } from "@lando/redaction/plan-values";
import { RedactionService } from "@lando/redaction/service";
import {
  EnvironmentValueResolutionError,
  SecretNotFoundError,
  SecretReferenceInvalidError,
  SecretStoreUnavailableError,
} from "@lando/sdk/errors";
import type { DataEndpoint, Environment, EnvironmentValue } from "@lando/sdk/schema";
import { isPublicDefaultCredential, isUsableExactRedactionValue } from "@lando/sdk/secrets";
import type { EnvironmentValueResolverSession } from "@lando/sdk/services";
import { Context, Effect, Schema } from "effect";
import type { SqlPlan } from "./views.ts";

/** Private operation context; the SDK resolver owns memoization and redaction. */
export class SqlEnvironmentSession extends Context.Service<
  SqlEnvironmentSession,
  EnvironmentValueResolverSession
>()("@lando/sql/EnvironmentSession") {}

export const isSqlBindingFailure = Schema.is(
  Schema.Union([
    SecretNotFoundError,
    SecretStoreUnavailableError,
    SecretReferenceInvalidError,
    EnvironmentValueResolutionError,
  ]),
);

export const resolveSqlEnvironment = Effect.fn("Sql.resolveEnvironment")(function* (env: Environment) {
  const session = yield* SqlEnvironmentSession;
  return yield* session.resolveEnvironment(env);
});

export type SqlCredentialSecrets = NonNullable<
  Extract<DataEndpoint, { readonly _tag: "serviceCmd" }>["secrets"]
>;

export type SqlPlanClassification = {
  readonly substring: ReadonlySet<string>;
  readonly wholeToken: ReadonlySet<string>;
  readonly publicValues: ReadonlySet<string>;
};

export const classifySqlPlan = (plan: SqlPlan): SqlPlanClassification => {
  const values = planRedactionValues(plan);
  return {
    substring: new Set(values.substring),
    wholeToken: values.wholeTokenValues,
    publicValues: values.publicValues,
  };
};

export const registerSqlLiteralCredentials = Effect.fn("Sql.registerLiteralCredentials")(function* (
  classified: SqlPlanClassification,
  selected: ReadonlyArray<EnvironmentValue>,
) {
  const redaction = yield* RedactionService;
  const substring: string[] = [];
  const wholeToken: string[] = [];
  for (const value of selected) {
    if (typeof value !== "string") continue;
    if (!isUsableExactRedactionValue(value)) continue;
    if (classified.publicValues.has(value) || isPublicDefaultCredential(value)) continue;
    // Only proven authored literals may use whole-token matching.
    if (classified.wholeToken.has(value) && !classified.substring.has(value)) {
      if (!wholeToken.includes(value)) wholeToken.push(value);
    } else if (!substring.includes(value)) {
      substring.push(value);
    }
  }
  yield* redaction.registerValues(substring);
  yield* redaction.registerValues(wholeToken, { match: "whole-token" });
  return { substring, wholeToken };
});

export const registerSqlCredentials = Effect.fn("Sql.registerCredentials")(function* (
  plan: SqlPlan,
  selected: ReadonlyArray<EnvironmentValue>,
) {
  const redaction = yield* RedactionService;
  const session = yield* SqlEnvironmentSession;
  const classified = classifySqlPlan(plan);
  const { substring, wholeToken } = yield* registerSqlLiteralCredentials(classified, selected);
  const raw = yield* session.resolveEnvironment(
    Object.fromEntries(selected.map((value, index) => [`credential${index}`, value])),
  );

  const resolvedSubstring: string[] = [];
  for (const [index, original] of selected.entries()) {
    if (typeof original === "string") continue;
    const resolved = raw[`credential${index}`];
    if (resolved === undefined || resolved.length === 0) continue;
    if (!isUsableExactRedactionValue(resolved)) continue;
    if (!resolvedSubstring.includes(resolved)) resolvedSubstring.push(resolved);
  }

  yield* redaction.registerValues(resolvedSubstring);
  substring.push(...resolvedSubstring.filter((value) => !substring.includes(value)));

  return {
    substringTokens: substring,
    secrets: { substring, wholeToken } satisfies SqlCredentialSecrets,
  };
});

/** Classify target credentials only when SQL first resolves an execution environment. */
export const protectSqlEnvironment = Effect.fn("Sql.protectEnvironment")(function* (
  session: EnvironmentValueResolverSession,
  plan: SqlPlan,
  selected: ReadonlyArray<EnvironmentValue>,
) {
  const redaction = yield* RedactionService;
  let tokens: ReadonlyArray<string> = [];
  let secrets: SqlCredentialSecrets = { substring: [], wholeToken: [] };
  const register = yield* registerSqlCredentials(plan, selected).pipe(
    Effect.provideService(SqlEnvironmentSession, session),
    Effect.provideService(RedactionService, redaction),
    Effect.tap((registered) =>
      Effect.sync(() => {
        tokens = registered.substringTokens;
        secrets = registered.secrets;
      }),
    ),
    Effect.cached,
  );
  return {
    register,
    tokens: () => tokens,
    secrets: () => secrets,
    session: {
      resolveEnvironment: (environment: Environment) =>
        register.pipe(Effect.andThen(session.resolveEnvironment(environment))),
    } satisfies EnvironmentValueResolverSession,
  };
});
