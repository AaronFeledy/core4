import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { Logger } from "@lando/sdk/services";

import { makeLandoRuntime } from "../../src/runtime/layer.ts";

type CapturedStreams = {
  readonly stdout: ReadonlyArray<string>;
  readonly stderr: ReadonlyArray<string>;
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
  const previousStdout = process.stdout.write;
  const previousStderr = process.stderr.write;
  const previousError = console.error;
  const previousInfo = console.info;
  const previousWarn = console.warn;
  const previousDebug = console.debug;
  process.stdout.write = collectWrite(stdout);
  process.stderr.write = collectWrite(stderr);
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
    return { stdout, stderr };
  } finally {
    process.stdout.write = previousStdout;
    process.stderr.write = previousStderr;
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

describe("makeLandoRuntime structured logging", () => {
  test("json renderer plus debug writes structured json lines on stderr", async () => {
    const captured = await withStderrTty(true, () =>
      captureStreams(() =>
        Effect.runPromise(
          Effect.flatMap(Logger, (logger) => logger.debug("json-debug-marker")).pipe(
            Effect.provide(makeLandoRuntime({ bootstrap: "minimal", renderer: "json", logLevel: "debug" })),
          ),
        ),
      ),
    );

    const stderrText = captured.stderr.join("");
    expect(stderrText).toContain("json-debug-marker");
    expect(stderrText).toContain('"logLevel"');
    expect(captured.stdout.join("")).not.toContain("json-debug-marker");
  });

  test("non-json renderer plus debug uses pretty TTY stderr", async () => {
    const captured = await withStderrTty(true, () =>
      captureStreams(() =>
        Effect.runPromise(
          Effect.flatMap(Logger, (logger) => logger.debug("pretty-debug-marker")).pipe(
            Effect.provide(makeLandoRuntime({ bootstrap: "minimal", renderer: "lando", logLevel: "debug" })),
          ),
        ),
      ),
    );

    const stderrText = captured.stderr.join("");
    expect(stderrText).toContain("pretty-debug-marker");
    expect(stderrText).not.toContain('"logLevel"');
    expect(captured.stdout.join("")).not.toContain("pretty-debug-marker");
  });
});
