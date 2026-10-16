import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit } from "effect";

import { defaultInterruptSignals, installSignalHandlers } from "../../src/runtime/interrupt.ts";

describe("default interrupt signals", () => {
  test("includes SIGBREAK on Windows and the gated POSIX set", () => {
    expect(defaultInterruptSignals("win32")).toEqual(["SIGINT", "SIGTERM", "SIGBREAK"]);
    expect(
      defaultInterruptSignals("linux", { stdinIsTTY: true, stdoutIsTTY: true, sigIgn: 0n }),
    ).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
    expect(
      defaultInterruptSignals("darwin", { stdinIsTTY: true, stdoutIsTTY: true }),
    ).toEqual(["SIGINT", "SIGTERM", "SIGHUP"]);
  });

  test("installs an explicit SIGHUP handler that interrupts the fiber", async () => {
    const before = process.listenerCount("SIGHUP");
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Effect.withFiber((fiber) => installSignalHandlers({ fiber, signals: ["SIGHUP"] }));
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
