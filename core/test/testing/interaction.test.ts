import { describe, expect, test } from "bun:test";

import { Cause, Effect, Exit, Option, Redacted, type Scope } from "effect";

import { makeTestInteractionService } from "@lando/core/testing";

const runScoped = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));

const runScopedExit = <A, E>(effect: Effect.Effect<A, E, Scope.Scope>): Promise<Exit.Exit<A, E>> =>
  Effect.runPromiseExit(Effect.scoped(effect));

const failureTag = <A, E>(exit: Exit.Exit<A, E>): string | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return Option.isSome(failure) ? (failure.value as { _tag?: string })._tag : undefined;
};

describe("makeTestInteractionService", () => {
  test("resolves seeded answers keyed by prompt name without opening stdin", async () => {
    const handle = makeTestInteractionService({ answers: { app: "blog" } });
    const answers = await runScoped(
      handle.service.promptAll([{ name: "app", type: "text", message: "Name?" }]),
    );
    expect(answers).toEqual({ app: "blog" });
  });

  test("captures the requested prompt transcript", async () => {
    const handle = makeTestInteractionService({ answers: { app: "blog", region: "us" } });
    await runScoped(
      handle.service.promptAll([
        { name: "app", type: "text", message: "Name?" },
        { name: "region", type: "text", message: "Region?" },
      ]),
    );
    const names = handle.transcript().map((entry) => entry.name);
    expect(names).toEqual(["app", "region"]);
  });

  test("is non-interactive by default: an unseeded required prompt fails fast", async () => {
    const handle = makeTestInteractionService({ answers: {} });
    const exit = await runScopedExit(
      handle.service.promptAll([{ name: "app", type: "text", message: "Name?" }]),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(failureTag(exit)).toBe("InteractionRequiredError");
  });

  test("never opens stdin even when a prompt is unseeded", async () => {
    let reads = 0;
    const failingStdin = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            reads += 1;
            return Promise.reject(new Error("stdin must not be read"));
          },
        };
      },
    } as unknown as NodeJS.ReadableStream;
    const handle = makeTestInteractionService({ answers: {}, stdin: failingStdin });
    await runScopedExit(handle.service.promptAll([{ name: "app", type: "text", message: "Name?" }]));
    expect(reads).toBe(0);
  });

  test("secret answers are carried as Redacted and never echoed", async () => {
    const handle = makeTestInteractionService({ answers: { token: "hunter2" } });
    const value = await runScoped(handle.service.secret({ name: "token", message: "Token?" }));
    expect(Redacted.value(value)).toBe("hunter2");
    expect(String(value)).not.toContain("hunter2");
  });

  test("exposes a Layer that provides the test InteractionService", async () => {
    const handle = makeTestInteractionService({ answers: { app: "blog" } });
    expect(handle.layer).toBeDefined();
    expect(handle.service.id).toBe("test-stdio");
  });
});
