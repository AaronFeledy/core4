import { describe, expect, test } from "bun:test";
import { RedactionService, registerRedactionValues } from "@lando/redaction/service";
import { createRedactor } from "@lando/sdk/secrets";
import { ShellRunner } from "@lando/sdk/services";
import { Deferred, Effect, Fiber, Layer } from "effect";
import * as BunShellRunner from "../../src/services/shell-runner.ts";
import { withShellRedactionTokens } from "../../src/services/shell-runner.ts";

const layer = Layer.mergeAll(
  BunShellRunner.layer(() => {
    throw new TypeError("Unexpected interactive shell");
  }),
  Layer.succeed(
    RedactionService,
    RedactionService.of({
      registerValues: registerRedactionValues,
      forProfile: (profile, options) =>
        Effect.succeed(
          createRedactor(profile, {
            values: options?.redactionTokens ?? [],
          }),
        ),
    }),
  ),
);
const output = "left-fiber-secret right-fiber-secret";
const failShell = Effect.flatMap(ShellRunner, (shell) => shell.exec(`printf '${output}'; exit 7`)).pipe(
  Effect.flip,
  Effect.map((error) => error.stdout),
);

describe("shell redaction fiber-local tokens", () => {
  test("defaults to no scoped tokens and restores them after a failed command", async () => {
    // Given / When
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const before = yield* failShell;
        const bound = yield* withShellRedactionTokens(["left-fiber-secret"], failShell);
        const after = yield* failShell;
        return { before, bound, after };
      }).pipe(Effect.provide(layer)),
    );
    // Then
    expect(result).toEqual({ before: output, bound: "[redacted] right-fiber-secret", after: output });
  });

  test("forked children redact inherited tokens", async () => {
    // Given / When
    const result = await Effect.runPromise(
      withShellRedactionTokens(
        ["left-fiber-secret"],
        Effect.gen(function* () {
          const child = yield* Effect.forkChild(failShell);
          return yield* Fiber.join(child);
        }),
      ).pipe(Effect.provide(layer)),
    );
    // Then
    expect(result).toBe("[redacted] right-fiber-secret");
  });

  test("overlapping siblings redact only their own tokens", async () => {
    // Given / When
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const left = yield* Deferred.make<void>();
        const right = yield* Deferred.make<void>();
        return yield* Effect.all(
          [
            withShellRedactionTokens(
              ["left-fiber-secret"],
              Deferred.succeed(left, undefined).pipe(
                Effect.andThen(Deferred.await(right)),
                Effect.andThen(failShell),
              ),
            ),
            withShellRedactionTokens(
              ["right-fiber-secret"],
              Deferred.succeed(right, undefined).pipe(
                Effect.andThen(Deferred.await(left)),
                Effect.andThen(failShell),
              ),
            ),
          ],
          { concurrency: 2 },
        );
      }).pipe(Effect.provide(layer)),
    );
    // Then
    expect(result).toEqual(["[redacted] right-fiber-secret", "left-fiber-secret [redacted]"]);
  });
});
