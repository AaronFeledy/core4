import { RedactionService } from "@lando/redaction/service";
import {
  EnvironmentValueResolutionError,
  SecretNotFoundError,
  SecretReferenceInvalidError,
  SecretStoreUnavailableError,
} from "@lando/sdk/errors";
import { type Environment, type EnvironmentValue, encodeUriComponent } from "@lando/sdk/schema";
import type { EnvironmentValueResolverSession } from "@lando/sdk/services";
import { Context, Effect, Schema } from "effect";

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

/** SQL owns credential classification, including literals and raw values behind references. */
export const registerSqlCredentials = Effect.fn("Sql.registerCredentials")(function* (
  selected: ReadonlyArray<EnvironmentValue>,
  env: Environment,
) {
  const redaction = yield* RedactionService;
  const literals = selected.filter((value): value is string => typeof value === "string");
  yield* redaction.registerValues(literals);
  const session = yield* SqlEnvironmentSession;
  const raw = yield* session.resolveEnvironment(
    Object.fromEntries(selected.map((value, index) => [`credential${index}`, value])),
  );
  const credentials = Object.values(raw).flatMap((value) => [
    value,
    ...(value.isWellFormed() ? [encodeUriComponent(value)] : []),
  ]);
  yield* redaction.registerValues(credentials);
  const emitted = yield* session.resolveEnvironment(env);
  const tokens = [...literals, ...credentials, ...Object.values(emitted)];
  yield* redaction.registerValues(tokens);
  return tokens;
});

/** Classify target credentials only when SQL first resolves an execution environment. */
export const protectSqlEnvironment = Effect.fn("Sql.protectEnvironment")(function* (
  session: EnvironmentValueResolverSession,
  selected: ReadonlyArray<EnvironmentValue>,
  env: Environment,
) {
  const redaction = yield* RedactionService;
  let tokens: ReadonlyArray<string> = [];
  const register = yield* registerSqlCredentials(selected, env).pipe(
    Effect.provideService(SqlEnvironmentSession, session),
    Effect.provideService(RedactionService, redaction),
    Effect.tap((registered) =>
      Effect.sync(() => {
        tokens = registered;
      }),
    ),
    Effect.cached,
  );
  return {
    register,
    tokens: () => tokens,
    session: {
      resolveEnvironment: (environment: Environment) =>
        register.pipe(Effect.andThen(session.resolveEnvironment(environment))),
    } satisfies EnvironmentValueResolverSession,
  };
});
