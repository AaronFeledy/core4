import type { McpTransportError } from "@lando/sdk/errors";
import { Deferred, Effect, type Scope, Stdio } from "effect";
import { guardStdio } from "./stdio-guard";

export const withStdioConnection = <E, R>(
  configure: (stdio: Stdio.Stdio) => Effect.Effect<void, E, R>,
): Effect.Effect<void, E | McpTransportError, Exclude<R, Scope.Scope> | Stdio.Stdio> =>
  Effect.scoped(
    Effect.gen(function* () {
      const terminal = yield* Deferred.make<void, McpTransportError>();
      const guarded = yield* guardStdio(yield* Stdio.Stdio, terminal);
      // Close admission before scoped setup resources begin their teardown.
      yield* configure(guarded.stdio).pipe(
        Effect.andThen(Deferred.await(terminal)),
        Effect.onExit(() => guarded.close),
      );
    }),
  );
