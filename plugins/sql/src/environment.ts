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
