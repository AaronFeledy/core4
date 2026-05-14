import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { Logger } from "@lando/core/services";
import { LoggerLive } from "../../src/logging/service.ts";

const captureConsoleLog = async (run: () => Promise<void>): Promise<ReadonlyArray<string>> => {
  const lines: Array<string> = [];
  const previousLog = console.log;
  try {
    console.log = (...args: ReadonlyArray<unknown>) => {
      lines.push(args.map(String).join(" "));
    };
    await run();
    return lines;
  } finally {
    console.log = previousLog;
  }
};

const runWithLogger = (effect: Effect.Effect<void, unknown, Logger>, mode: "pretty" | "silent" = "pretty") =>
  Effect.runPromise(effect.pipe(Effect.provide(LoggerLive({ mode }))));

describe("LoggerLive", () => {
  test("logs info, warn, and error through Effect pretty output", async () => {
    const lines = await captureConsoleLog(() =>
      runWithLogger(
        Effect.flatMap(Logger, (logger) =>
          Effect.gen(function* () {
            yield* logger.info("hello info");
            yield* logger.warn("hello warn");
            yield* logger.error("hello error");
          }),
        ),
      ),
    );

    expect(lines.some((line) => line.includes("INFO") && line.includes("hello info"))).toBe(true);
    expect(lines.some((line) => line.includes("WARN") && line.includes("hello warn"))).toBe(true);
    expect(lines.some((line) => line.includes("ERROR") && line.includes("hello error"))).toBe(true);
  });

  test("silent mode produces no output", async () => {
    const lines = await captureConsoleLog(() =>
      runWithLogger(
        Effect.flatMap(Logger, (logger) => logger.info("hidden")),
        "silent",
      ),
    );

    expect(lines).toEqual([]);
  });
});
