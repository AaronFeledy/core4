import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Cause, type Context, Effect, Exit, Layer, Schema, Stream } from "effect";

import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { CommandStdioError } from "@lando/sdk/errors";
import type { ExecutableCommandInput, ExecutableCommandSpec } from "@lando/sdk/plugins";
import { RENDERER_CAPABILITIES_NONE } from "@lando/sdk/renderer";
import { Renderer } from "@lando/sdk/services";

import { grantCommandStdio } from "../../src/cli/command-stdio.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { pluginOwnedCommandEffect } from "../../src/cli/run-plugin-owned-command.ts";

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (chunk: Uint8Array): string => new TextDecoder().decode(chunk);

class FakeStdin extends EventEmitter {
  readonly isTTY: boolean;
  readableEnded = false;
  readableFlowing: boolean | null = null;
  constructor(isTTY: boolean) {
    super();
    this.isTTY = isTTY;
  }
  pause(): this {
    return this;
  }
  resume(): this {
    return this;
  }
}

const capturingRenderer = (output: { stdout: string; stderr: string }) =>
  Renderer.of({
    id: "plain",
    capabilities: RENDERER_CAPABILITIES_NONE,
    message: { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void },
    output: {
      stdout: (chunk) =>
        Effect.sync(() => {
          output.stdout += typeof chunk === "string" ? chunk : decode(chunk);
        }),
      stderr: (chunk) =>
        Effect.sync(() => {
          output.stderr += typeof chunk === "string" ? chunk : decode(chunk);
        }),
    },
  } satisfies Context.Service.Shape<typeof Renderer>);

const stdioSpec = <E = never, R = never>(
  id: string,
  body: Partial<ExecutableCommandSpec<void, E, R>> & Pick<ExecutableCommandSpec<void, E, R>, "run" | "stdio">,
): ExecutableCommandSpec<void, E, R> => ({
  id,
  namespace: "db",
  bootstrap: "app",
  resultSchema: Schema.Void,
  args: { file: { type: "string" } },
  ...body,
});

beforeEach(() => {
  process.exitCode = 0;
});
afterEach(() => {
  process.exitCode = 0;
});

describe("grantCommandStdio", () => {
  test("refuses stdout when routing is envelope or frames (machine-output)", async () => {
    const base = capturingRenderer({ stdout: "", stderr: "" });
    const exit = await Effect.runPromiseExit(
      grantCommandStdio({
        command: "db:export",
        request: { stdout: true },
        baseStdout: base.output.stdout,
        stdoutIsTTY: false,
        stdinIsTTY: false,
        resultFormat: "json",
        rendererMode: "lando",
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(CommandStdioError);
      if (error instanceof CommandStdioError) {
        expect(error.reason).toBe("machine-output");
        expect(error.stream).toBe("stdout");
      }
    }
  });

  test("allows --renderer=json with text format (routing stays human)", async () => {
    const output = { stdout: "", stderr: "" };
    const base = capturingRenderer(output);
    const granted = await Effect.runPromise(
      grantCommandStdio({
        command: "db:export",
        request: { stdout: true },
        baseStdout: base.output.stdout,
        stdoutIsTTY: false,
        stdinIsTTY: false,
        resultFormat: "text",
        rendererMode: "json",
      }),
    );
    if (granted?.stdout === undefined) throw new Error("expected stdout grant");
    await Effect.runPromise(granted.stdout(bytes("dump-bytes")));
    expect(output).toEqual({ stdout: "dump-bytes", stderr: "" });
  });

  test("refuses stdout and stdin when the requested stream is a TTY", async () => {
    const base = capturingRenderer({ stdout: "", stderr: "" });
    for (const [request, stream, stdoutIsTTY, stdinIsTTY] of [
      [{ stdout: true }, "stdout", true, false],
      [{ stdin: true }, "stdin", false, true],
    ] as const) {
      const exit = await Effect.runPromiseExit(
        grantCommandStdio({
          command: "db:import",
          request,
          baseStdout: base.output.stdout,
          stdoutIsTTY,
          stdinIsTTY,
          resultFormat: "text",
          rendererMode: "plain",
        }),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      if (Exit.isFailure(exit)) {
        const error = Cause.squash(exit.cause);
        expect(error).toBeInstanceOf(CommandStdioError);
        if (error instanceof CommandStdioError) {
          expect(error.reason).toBe("terminal");
          expect(error.stream).toBe(stream);
        }
      }
    }
  });
});

describe("pluginOwnedCommandEffect stdio grants", () => {
  test("refuses before run when stdout is requested under a machine format", async () => {
    let ran = false;
    const spec = stdioSpec("db:export", {
      stdio: () => ({ stdout: true }),
      run: () =>
        Effect.sync(() => {
          ran = true;
        }),
    });
    const exit = await Effect.runPromiseExit(
      pluginOwnedCommandEffect(spec, ["-"], false, {
        resultFormat: "json",
        stdoutIsTTY: false,
        stdinIsTTY: false,
      }).pipe(Effect.provideService(Renderer, capturingRenderer({ stdout: "", stderr: "" }))),
    );
    expect(ran).toBe(false);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(CommandStdioError);
      if (error instanceof CommandStdioError) expect(error.reason).toBe("machine-output");
    }
  });

  test("granted stdout writes secret bytes exact while ordinary renderer output still redacts", async () => {
    const secret = "stdio-grant-canary-secret-9910";
    const output = { stdout: "", stderr: "" };
    const redaction = makeRedactionService();
    const spec = stdioSpec("db:export", {
      stdio: () => ({ stdout: true }),
      run: (input: ExecutableCommandInput) =>
        Effect.gen(function* () {
          yield* (yield* RedactionService).registerValues([secret]);
          const granted = input.stdio?.stdout;
          if (granted === undefined) throw new Error("expected stdout grant");
          yield* granted(bytes(secret));
          const renderer = yield* Renderer;
          yield* renderer.output.stdout(bytes(`${secret}-narration`));
          yield* renderer.output.stderr(bytes(`${secret}-err`));
        }),
    });

    await Effect.runPromise(
      pluginOwnedCommandEffect(spec, ["-"], false, {
        resultFormat: "text",
        stdoutIsTTY: false,
        stdinIsTTY: false,
      }).pipe(
        Effect.provideService(Renderer, capturingRenderer(output)),
        Effect.provideService(RedactionService, redaction),
      ),
    );

    expect(output.stdout).toBe(`${secret}[redacted]-narration`);
    expect(output.stderr).toBe("[redacted]-err");
  });

  test("granted stdin delivers bytes from an injectable source", async () => {
    const stdin = new PassThrough();
    let received = "";
    const spec = stdioSpec("db:import", {
      stdio: () => ({ stdin: true }),
      run: (input: ExecutableCommandInput) =>
        Effect.gen(function* () {
          const stream = input.stdio?.stdin;
          if (stream === undefined) throw new Error("expected stdin grant");
          const chunks = yield* Stream.runCollect(stream);
          received = [...chunks].map(decode).join("");
        }),
    });

    const fiber = Effect.runPromise(
      pluginOwnedCommandEffect(spec, ["-"], false, {
        stdin,
        stdinIsTTY: false,
        stdoutIsTTY: false,
        resultFormat: "text",
      }).pipe(Effect.provideService(Renderer, capturingRenderer({ stdout: "", stderr: "" }))),
    );
    stdin.write("dump-bytes");
    stdin.end();
    await fiber;
    expect(received).toBe("dump-bytes");
  });

  test("granted stdin refuses a second consumer instead of splitting the payload", async () => {
    // Given
    const stdin = new PassThrough();
    const granted = await Effect.runPromise(
      grantCommandStdio({
        command: "db:import",
        request: { stdin: true },
        baseStdout: () => Effect.void,
        stdoutIsTTY: false,
        stdinIsTTY: false,
        stdin,
        resultFormat: "text",
        rendererMode: "plain",
      }),
    );
    const stream = granted?.stdin;
    if (stream === undefined) throw new Error("expected stdin grant");
    const first = Effect.runPromise(Stream.runCollect(stream));
    // When
    const second = await Effect.runPromiseExit(Stream.runCollect(stream));
    stdin.end("payload");
    // Then
    expect([...(await first)].map(decode).join("")).toBe("payload");
    expect(Exit.isFailure(second)).toBe(true);
    if (Exit.isFailure(second)) {
      const error = Cause.squash(second.cause);
      expect(error).toBeInstanceOf(CommandStdioError);
      if (error instanceof CommandStdioError) expect(error.reason).toBe("read");
    }
  });

  test("stdin read errors surface as CommandStdioError reason read", async () => {
    const stdin = new FakeStdin(false);
    const listening = new Promise<void>((resolve) => {
      stdin.on("newListener", function onListener(event) {
        if (event !== "error") return;
        stdin.off("newListener", onListener);
        resolve();
      });
    });
    const spec = stdioSpec("db:import", {
      stdio: () => ({ stdin: true }),
      run: (input: ExecutableCommandInput) =>
        Effect.gen(function* () {
          const stream = input.stdio?.stdin;
          if (stream === undefined) throw new Error("expected stdin grant");
          yield* Stream.runDrain(stream);
        }),
    });

    const pending = Effect.runPromiseExit(
      pluginOwnedCommandEffect(spec, ["-"], false, {
        stdin,
        stdinIsTTY: false,
        stdoutIsTTY: false,
        resultFormat: "text",
      }).pipe(Effect.provideService(Renderer, capturingRenderer({ stdout: "", stderr: "" }))),
    );
    await listening;
    stdin.emit("error", new Error("broken pipe"));
    const exit = await pending;
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const error = Cause.squash(exit.cause);
      expect(error).toBeInstanceOf(CommandStdioError);
      if (error instanceof CommandStdioError) {
        expect(error.reason).toBe("read");
        expect(error.stream).toBe("stdin");
      }
    }
  });
});

describe("CommandStdioError exit codes at the renderer boundary", () => {
  test.each([
    ["terminal", 2],
    ["machine-output", 2],
    ["unavailable", 2],
    ["read", 1],
  ] as const)("maps reason %s to exit %d", async (reason, expected) => {
    const io = createBufferedRendererIO();
    const codes: number[] = [];
    await runWithRendererHandling(
      Effect.fail(
        new CommandStdioError({
          message: `stdio ${reason}`,
          command: "db:export",
          stream: reason === "read" || reason === "unavailable" ? "stdin" : "stdout",
          reason,
          remediation: "Fix the stream.",
        }),
      ),
      {
        runtime: Layer.empty,
        rendererMode: "plain",
        resultFormat: "text",
        command: "db:export",
        io,
        setExitCode: (code) => codes.push(code),
        render: () => undefined,
        formatError: (failure) =>
          failure.error instanceof Error ? failure.error.message : String(failure.error),
      },
    );
    expect(codes).toEqual([expected]);
  });
});
