import { Context, type Effect, type Scope } from "effect";
import type { EnvironmentValueResolutionError, SecretStoreError } from "../errors/index.ts";
import type { Environment } from "../schema/environment-value.ts";

/** The enclosing operation Scope releases the memo; masking remains owned by the runtime through output drain. */
export interface EnvironmentValueResolverSession {
  readonly resolveEnvironment: (
    environment: Environment,
  ) => Effect.Effect<Record<string, string>, SecretStoreError | EnvironmentValueResolutionError>;
}

export class EnvironmentValueResolver extends Context.Service<
  EnvironmentValueResolver,
  {
    readonly openSession: () => Effect.Effect<EnvironmentValueResolverSession, never, Scope.Scope>;
  }
>()("@lando/core/EnvironmentValueResolver") {}
