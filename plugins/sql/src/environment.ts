import {
  EnvironmentValueResolutionError,
  SecretNotFoundError,
  SecretReferenceInvalidError,
  SecretStoreUnavailableError,
} from "@lando/sdk/errors";
import type { Environment } from "@lando/sdk/schema";
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
