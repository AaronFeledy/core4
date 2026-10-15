import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";

import { defaultInterruptSignals, installSignalHandlers } from "../../src/runtime/interrupt.ts";

describe("default interrupt signals", () => {
  test("includes SIGHUP on POSIX and SIGBREAK on Windows", () => {
    expect(defaultInterruptSignals("linux")).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    expect(defaultInterruptSignals("darwin")).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    expect(defaultInterruptSignals("win32")).toEqual(["SIGINT", "SIGTERM", "SIGBREAK"]);
    expect(defaultInterruptSignals()).toEqual(
      process.platform === "win32" ? ["SIGINT", "SIGTERM", "SIGBREAK"] : ["SIGINT", "SIGTERM", "SIGHUP"],
    );
  });

  test("installs the default POSIX set including SIGHUP", async () => {
    const before = process.listenerCount("SIGHUP");
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.withFiber((fiber) => installSignalHandlers({ fiber }));
          expect(process.listenerCount("SIGHUP")).toBe(before + 1);
          process.emit("SIGHUP");
          yield* Effect.never;
        }),
      ),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) throw new Error("expected SIGHUP interruption");
    expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    expect(process.listenerCount("SIGHUP")).toBe(before);
  });
});
