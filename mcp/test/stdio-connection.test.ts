import { expect, test } from "bun:test";
import type { McpTransportError } from "@lando/sdk/errors";
import { Cause, Context, Deferred, Effect, Exit, Fiber, type Scope, Stdio, Stream } from "effect";
import { forEach as forEachChunk } from "effect/Sink";
import { withStdioConnection } from "../src/stdio-connection";
import { makeStdioClient } from "../src/testing";

for (const outcome of ["failure", "interrupt"] as const) {
  test(`closes admission before partial setup finalizers on ${outcome}`, async () => {
    const failure = new Error("configure failed");
    const writes: string[] = [];
    const finalized: string[] = [];
    const exit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Given setup that acquires a resource whose cleanup attempts a guarded write.
          const client = yield* makeStdioClient();
          const acquired = yield* Deferred.make<void>();
          const stdio = Stdio.make({
            ...client.stdio,
            stdout: () =>
              forEachChunk((chunk: string | Uint8Array) =>
                Effect.sync(() => {
                  writes.push(String(chunk));
                }),
              ),
          });
          const connection = withStdioConnection((guarded) =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() =>
                Stream.run(Stream.make("late\n"), guarded.stdout()).pipe(
                  Effect.orDie,
                  Effect.andThen(
                    Effect.sync(() => {
                      finalized.push("resource");
                    }),
                  ),
                ),
              );
              yield* Deferred.succeed(acquired, undefined);
              return yield* outcome === "failure" ? Effect.fail(failure) : Effect.never;
            }),
          ).pipe(Effect.provideService(Stdio.Stdio, stdio));
          // When configuration fails or is interrupted before setup completes.
          const fiber = yield* connection.pipe(Effect.forkScoped);
          yield* Deferred.await(acquired);
          if (outcome === "interrupt") yield* Fiber.interrupt(fiber);
          return yield* Fiber.await(fiber);
        }),
      ),
    );
    // Then cleanup cannot reach raw stdout and the original terminal cause survives.
    expect(finalized).toEqual(["resource"]);
    expect(writes).toEqual([]);
    if (outcome === "failure") expect(exit).toEqual(Exit.fail(failure));
    else expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  });
}

test("successful immediate configuration remains pending until EOF", async () => {
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // Given configuration that starts input consumption and immediately returns.
        const client = yield* makeStdioClient();
        const configured = yield* Deferred.make<void>();
        const fiber = yield* withStdioConnection((stdio) =>
          Effect.gen(function* () {
            yield* Stream.runDrain(stdio.stdin).pipe(Effect.forkScoped);
            yield* Deferred.succeed(configured, undefined);
          }),
        ).pipe(Effect.provideService(Stdio.Stdio, client.stdio), Effect.forkScoped);
        yield* Deferred.await(configured);
        yield* Effect.yieldNow;
        expect(fiber.pollUnsafe()).toBeUndefined();
        // When input reaches EOF, the owner can finish successfully.
        yield* client.close;
        expect(yield* Fiber.await(fiber)).toEqual(Exit.void);
      }),
    ),
  );
});

class SetupRequirement extends Context.Service<SetupRequirement, { readonly ready: boolean }>()(
  "test/SetupRequirement",
) {}
class SetupFailure extends Error {
  readonly _tag = "SetupFailure";
}
const assertType = <T extends true>(value: T): T => value;
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

test("preserves configuration requirements and errors while owning Scope", () => {
  // Given setup with its own service, scoped resource and failure channel.
  const configure: (stdio: Stdio.Stdio) => Effect.Effect<void, SetupFailure, SetupRequirement | Scope.Scope> =
    () =>
      SetupRequirement.pipe(
        Effect.andThen(Effect.addFinalizer(() => Effect.void)),
        Effect.andThen(Effect.fail(new SetupFailure())),
      );
  // When the connection owns the setup scope, only Scope is removed.
  const connection = withStdioConnection(configure);
  // Then both generic channels remain exactly represented at compile time.
  assertType<Equal<Effect.Services<typeof connection>, SetupRequirement | Stdio.Stdio>>(true);
  assertType<Equal<Effect.Error<typeof connection>, SetupFailure | McpTransportError>>(true);
});
