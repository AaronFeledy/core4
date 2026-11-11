import { describe, expect, test } from "bun:test";
import { tryPromiseSettled } from "@lando/sdk/abortable-promise";
import { Cause, Effect, Exit } from "effect";

describe("tryPromiseSettled", () => {
  test("succeeds with the resolved value", async () => {
    const result = await Effect.runPromise(
      tryPromiseSettled({
        try: async () => 42,
        catch: (cause) => cause,
      }),
    );
    expect(result).toBe(42);
  });

  test("maps rejections through catch", async () => {
    const error = await Effect.runPromise(
      tryPromiseSettled({
        try: async () => {
          throw new Error("boom");
        },
        catch: (cause) => (cause instanceof Error ? cause.message : "other"),
      }).pipe(Effect.flip),
    );
    expect(error).toBe("boom");
  });

  test("interruption awaits promise cleanup before the fiber exit settles", async () => {
    const started = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const cleanup = Promise.withResolvers<void>();
    const controller = new AbortController();
    let cleaned = false;
    let settled = false;
    const completion = Effect.runPromiseExit(
      tryPromiseSettled({
        try: async (signal) => {
          signal.addEventListener("abort", () => aborted.resolve(), { once: true });
          started.resolve();
          await aborted.promise;
          await cleanup.promise;
          cleaned = true;
          throw signal.reason;
        },
        catch: (cause) => cause,
      }),
      { signal: controller.signal },
    );
    void completion.then(() => {
      settled = true;
    });
    try {
      await started.promise;
      controller.abort();
      await aborted.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
    } finally {
      cleanup.resolve();
    }
    const exit = await completion;
    expect(cleaned).toBe(true);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
  });
});
