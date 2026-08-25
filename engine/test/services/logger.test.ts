import { describe, expect, test } from "bun:test";
import { type Context, Effect, Layer } from "effect";

import { RedactionService } from "@lando/redaction/service";
import { createRedactor } from "@lando/sdk/secrets";
import { Logger } from "@lando/sdk/services";
import { LoggerLive, type LoggerLiveOptions } from "../../src/logging/service";

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

type CapturedStreams = {
  readonly stdout: ReadonlyArray<string>;
  readonly stderr: ReadonlyArray<string>;
  readonly consoleLog: ReadonlyArray<string>;
};

const collectWrite = (chunks: Array<string>): typeof process.stdout.write => {
  const write = (chunk: unknown, encodingOrCb?: unknown, cb?: unknown): boolean => {
    chunks.push(String(chunk));
    if (typeof encodingOrCb === "function") encodingOrCb();
    if (typeof cb === "function") cb();
    return true;
  };
  return write as typeof process.stdout.write;
};

const captureStreams = async (run: () => Promise<void>): Promise<CapturedStreams> => {
  const stdout: Array<string> = [];
  const stderr: Array<string> = [];
  const consoleLog: Array<string> = [];
  const previousStdout = process.stdout.write;
  const previousStderr = process.stderr.write;
  const previousLog = console.log;
  const previousError = console.error;
  const previousInfo = console.info;
  const previousWarn = console.warn;
  const previousDebug = console.debug;
  process.stdout.write = collectWrite(stdout);
  process.stderr.write = collectWrite(stderr);
  console.log = (...args: ReadonlyArray<unknown>) => {
    consoleLog.push(args.map(String).join(" "));
  };
  console.info = (...args: ReadonlyArray<unknown>) => {
    stdout.push(args.map(String).join(" "));
  };
  console.warn = (...args: ReadonlyArray<unknown>) => {
    stderr.push(args.map(String).join(" "));
  };
  console.error = (...args: ReadonlyArray<unknown>) => {
    stderr.push(args.map(String).join(" "));
  };
  console.debug = (...args: ReadonlyArray<unknown>) => {
    stderr.push(args.map(String).join(" "));
  };
  try {
    await run();
    return { stdout, stderr, consoleLog };
  } finally {
    process.stdout.write = previousStdout;
    process.stderr.write = previousStderr;
    console.log = previousLog;
    console.error = previousError;
    console.info = previousInfo;
    console.warn = previousWarn;
    console.debug = previousDebug;
  }
};

const withStderrTty = async <T>(isTTY: boolean, run: () => Promise<T>): Promise<T> => {
  const descriptor = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  Object.defineProperty(process.stderr, "isTTY", {
    configurable: true,
    enumerable: true,
    value: isTTY,
  });
  try {
    return await run();
  } finally {
    if (descriptor === undefined) {
      Object.defineProperty(process.stderr, "isTTY", { configurable: true, value: undefined });
    } else {
      Object.defineProperty(process.stderr, "isTTY", descriptor);
    }
  }
};

const writeStderrLine = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

const runWithLogger = (effect: Effect.Effect<void, unknown, Logger>, options: LoggerLiveOptions = {}) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(LoggerLive({ writeLine: writeStderrLine, stderrIsTTY: true, ...options }))),
  );

const logProgram = (run: (logger: Context.Tag.Service<typeof Logger>) => Effect.Effect<void, unknown>) =>
  Effect.flatMap(Logger, run);

describe("LoggerLive characterization", () => {
  test("pretty mode emits info, warn, and error through console.log", async () => {
    const lines = await captureConsoleLog(() =>
      runWithLogger(
        logProgram((logger) =>
          Effect.gen(function* () {
            yield* logger.info("hello info");
            yield* logger.warn("hello warn");
            yield* logger.error("hello error");
          }),
        ),
        { mode: "pretty" },
      ),
    );

    expect(lines.some((line) => line.includes("INFO") && line.includes("hello info"))).toBe(true);
    expect(lines.some((line) => line.includes("WARN") && line.includes("hello warn"))).toBe(true);
    expect(lines.some((line) => line.includes("ERROR") && line.includes("hello error"))).toBe(true);
  });

  test("silent mode produces no console.log output", async () => {
    const lines = await captureConsoleLog(() =>
      runWithLogger(
        logProgram((logger) => logger.info("hidden")),
        { mode: "silent" },
      ),
    );

    expect(lines).toEqual([]);
  });
});

describe("LoggerLive logLevel and stderr", () => {
  test("emits nothing on stderr or stdout at logLevel none", async () => {
    const captured = await withStderrTty(true, () =>
      captureStreams(() =>
        runWithLogger(
          logProgram((logger) =>
            Effect.gen(function* () {
              yield* logger.debug("hidden debug");
              yield* logger.info("hidden info");
            }),
          ),
          { logLevel: "none" },
        ),
      ),
    );

    expect(captured.stdout.join("")).not.toContain("hidden debug");
    expect(captured.stdout.join("")).not.toContain("hidden info");
    expect(captured.stderr.join("")).not.toContain("hidden debug");
    expect(captured.stderr.join("")).not.toContain("hidden info");
    expect(captured.consoleLog.join("")).not.toContain("hidden debug");
    expect(captured.consoleLog.join("")).not.toContain("hidden info");
  });

  test("omitted logLevel plus silent mode emits nothing", async () => {
    const captured = await withStderrTty(true, () =>
      captureStreams(() =>
        runWithLogger(
          logProgram((logger) =>
            Effect.gen(function* () {
              yield* logger.debug("hidden debug");
              yield* logger.info("hidden info");
            }),
          ),
          { mode: "silent" },
        ),
      ),
    );

    expect(captured.stderr.join("")).not.toContain("hidden");
    expect(captured.stdout.join("")).not.toContain("hidden");
  });

  test("writes logger.debug to stderr and not stdout at logLevel debug", async () => {
    const captured = await withStderrTty(true, () =>
      captureStreams(() =>
        runWithLogger(
          logProgram((logger) => logger.debug("x")),
          { logLevel: "debug" },
        ),
      ),
    );

    expect(captured.stderr.some((line) => line.includes("x"))).toBe(true);
    expect(captured.stdout.some((line) => line.includes("x"))).toBe(false);
    expect(captured.consoleLog.some((line) => line.includes("x"))).toBe(false);
  });

  test("hides logger.info and writes logger.error to stderr at logLevel error", async () => {
    const captured = await withStderrTty(true, () =>
      captureStreams(() =>
        runWithLogger(
          logProgram((logger) =>
            Effect.gen(function* () {
              yield* logger.info("hidden info");
              yield* logger.error("shown error");
            }),
          ),
          { logLevel: "error" },
        ),
      ),
    );

    expect(captured.stderr.some((line) => line.includes("shown error"))).toBe(true);
    expect(captured.stderr.some((line) => line.includes("hidden info"))).toBe(false);
    expect(captured.stdout.some((line) => line.includes("shown error"))).toBe(false);
    expect(captured.consoleLog.some((line) => line.includes("shown error"))).toBe(false);
  });

  test("writes structured json to stderr when structured is true even if stderr is a TTY", async () => {
    const captured = await withStderrTty(true, () =>
      captureStreams(() =>
        runWithLogger(
          logProgram((logger) => logger.info("structured-marker")),
          {
            logLevel: "info",
            structured: true,
          },
        ),
      ),
    );

    const stderrText = captured.stderr.join("");
    expect(stderrText).toContain("structured-marker");
    expect(stderrText).toContain('"logLevel"');
    expect(captured.stdout.join("")).not.toContain("structured-marker");
  });

  test("writes pretty stderr when structured is omitted and stderr is a TTY", async () => {
    const captured = await withStderrTty(true, () =>
      captureStreams(() =>
        runWithLogger(
          logProgram((logger) => logger.info("pretty-marker")),
          {
            logLevel: "info",
          },
        ),
      ),
    );

    const stderrText = captured.stderr.join("");
    expect(stderrText).toContain("pretty-marker");
    expect(stderrText).not.toContain('"logLevel"');
  });

  test("passes message and data through when RedactionService is absent", async () => {
    const captured = await withStderrTty(true, () =>
      captureStreams(() =>
        runWithLogger(
          logProgram((logger) => logger.info("token=super-secret-value", { token: "super-secret-value" })),
          { logLevel: "info" },
        ),
      ),
    );

    const stderrText = captured.stderr.join("");
    expect(stderrText).toContain("super-secret-value");
  });

  test("redacts message and data when RedactionService is present", async () => {
    const redaction = Layer.succeed(RedactionService, {
      forProfile: () => Effect.succeed(createRedactor("secrets", { values: ["super-secret-value"] })),
    });
    const captured = await withStderrTty(true, () =>
      captureStreams(() =>
        Effect.runPromise(
          logProgram((logger) =>
            logger.info("token=super-secret-value", { token: "super-secret-value" }),
          ).pipe(
            Effect.provide(
              Layer.mergeAll(
                LoggerLive({ logLevel: "info", writeLine: writeStderrLine, stderrIsTTY: true }),
                redaction,
              ),
            ),
          ),
        ),
      ),
    );

    const stderrText = captured.stderr.join("");
    expect(stderrText).not.toContain("super-secret-value");
    expect(stderrText.length).toBeGreaterThan(0);
  });
});
