import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer, Schema } from "effect";

import { type DeprecationNotice, StreamFrame } from "@lando/sdk/schema";
import { DeprecationService, EventService, Renderer } from "@lando/sdk/services";

import {
  makeRendererServiceLiveForMode,
  resolveCliDeprecationWarnings,
  runWithRendererHandling,
  writeDiagnosticLine,
  writeResultLine,
} from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import { DeprecationServiceLive } from "../../src/deprecation/service.ts";

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("makeRendererServiceLiveForMode", () => {
  for (const mode of ["lando", "json", "plain", "verbose"] as const) {
    test(`selects the ${mode} renderer`, () => {
      const id = Effect.runSync(
        Effect.gen(function* () {
          const renderer = yield* Renderer;
          return renderer.id;
        }).pipe(Effect.provide(makeRendererServiceLiveForMode(mode, createBufferedRendererIO()))),
      );
      expect(id).toBe(mode);
    });
  }
});

describe("runWithRendererHandling", () => {
  const warningNotice: DeprecationNotice = {
    since: "4.1.0",
    severity: "warn",
    note: "Use app:up instead.",
    replacement: "app:up",
  };
  const infoNotice: DeprecationNotice = {
    since: "4.1.0",
    severity: "info",
    note: "Prefer the new surface when convenient.",
  };
  const timestamp = DateTime.unsafeMake("2026-06-12T12:00:00.000Z");
  const decodeFrame = (line: string) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line));

  test("writes render(value) to stdout on success", async () => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(Effect.succeed(42), {
      runtime: Layer.empty,
      rendererMode: "lando",
      io,
      render: (n) => `value=${n}`,
      formatError: () => "should not happen",
    });
    expect(io.stdout()).toBe("value=42\n");
    expect(io.stderr()).toBe("");
    expect(process.exitCode).not.toBe(1);
  });

  test("skips empty/undefined render output", async () => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(Effect.succeed("x"), {
      runtime: Layer.empty,
      rendererMode: "lando",
      io,
      render: () => undefined,
      formatError: () => "nope",
    });
    expect(io.stdout()).toBe("");
  });

  test("plain event rendering keeps tooling output flat", async () => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(
      Effect.gen(function* () {
        const events = yield* EventService;
        yield* events.publish({
          _tag: "task.tree.start",
          parentId: "tooling:composer",
          label: "Tooling: composer",
          children: ["tooling:composer:appserver"],
          timestamp: "2026-06-04T00:00:00.000Z",
        });
        yield* events.publish({
          _tag: "task.start",
          taskId: "tooling:composer:appserver",
          parentId: "tooling:composer",
          label: "appserver",
          timestamp: "2026-06-04T00:00:00.001Z",
        });
        yield* events.publish({
          _tag: "task.detail",
          taskId: "tooling:composer:appserver",
          stream: "stdout",
          line: "installing",
          timestamp: "2026-06-04T00:00:00.002Z",
        });
        yield* events.publish({
          _tag: "task.complete",
          taskId: "tooling:composer:appserver",
          summary: "completed with exit code 0",
          durationMs: 10,
          timestamp: "2026-06-04T00:00:00.003Z",
        });
        yield* events.publish({
          _tag: "task.tree.complete",
          parentId: "tooling:composer",
          succeeded: 1,
          failed: 0,
          durationMs: 11,
          timestamp: "2026-06-04T00:00:00.004Z",
        });
      }),
      {
        runtime: Layer.empty,
        rendererMode: "plain",
        io,
        renderEvents: true,
        plainTaskEvents: "detail-only",
        render: () => undefined,
        formatError: () => "should not happen",
      },
    );
    expect(io.stdout()).toBe("[tooling:composer:appserver] installing\n");
  });

  test("json consumes notify.desktop without enabling unrelated event rendering", async () => {
    // Given: a default command that did not opt into task/event rendering.
    const io = createBufferedRendererIO();

    // When: its runtime publishes a notification and an unrelated task event.
    await runWithRendererHandling(
      Effect.gen(function* () {
        const events = yield* EventService;
        yield* events.publish({ _tag: "notify.desktop", title: "Done", urgency: "success" });
        yield* events.publish({
          _tag: "task.detail",
          taskId: "unrelated",
          stream: "stdout",
          line: "not rendered",
          timestamp: "2026-07-18T00:00:00.000Z",
        });
      }),
      {
        runtime: Layer.empty,
        rendererMode: "json",
        resultFormat: "json",
        io,
        command: "meta:global:list",
        render: () => undefined,
        formatError: () => "should not happen",
      },
    );

    // Then: the notification is a structured event and task rendering remains opt-in.
    const lines = io.stderrLines().map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ _tag: "notify.desktop", title: "Done", urgency: "success" });
    expect(io.stderr()).not.toContain("not rendered");
  });

  test("json streaming emits chunks, bounded events, and a terminal result frame in order", async () => {
    const io = createBufferedRendererIO();
    const secret = "stream-secret-value";
    process.env.LANDO_SECRET_STREAM_FRAME_TEST = secret;
    try {
      await runWithRendererHandling(
        Effect.gen(function* () {
          const events = yield* EventService;
          yield* events.publish({
            _tag: "task.detail",
            taskId: "app:logs:web",
            stream: "stdout",
            line: `token=${secret}`,
            timestamp: "2026-06-04T00:00:00.000Z",
          });
          return { message: `done ${secret}` };
        }),
        {
          runtime: Layer.empty,
          rendererMode: "json",
          resultFormat: "json",
          io,
          command: "app:logs",
          resultSchema: Schema.Struct({ message: Schema.String }),
          streaming: StreamFrame,
          streamFrames: () => [
            { _tag: "stdout", service: "web", chunk: `stdout ${secret}\n` },
            { _tag: "stderr", service: "web", chunk: `stderr ${secret}\n` },
          ],
          render: () => "should not render",
          formatError: () => "should not happen",
        },
      );
    } finally {
      process.env.LANDO_SECRET_STREAM_FRAME_TEST = undefined;
    }

    expect(io.stderr()).toBe("");
    expect(io.stdout()).not.toContain(secret);
    const frames = io.stdoutLines().map(decodeFrame);
    expect(frames.map((frame) => frame._tag)).toEqual(["stdout", "stderr", "event", "result"]);
    expect(frames[0]).toEqual({ _tag: "stdout", service: "web", chunk: "stdout [redacted]\n" });
    expect(frames[1]).toEqual({ _tag: "stderr", service: "web", chunk: "stderr [redacted]\n" });
    const event = frames[2];
    if (event?._tag !== "event") throw new Error("expected event frame");
    expect(event.event).toBe("task.detail");
    expect(JSON.stringify(event.payload)).toContain("[redacted]");
    const result = frames[3];
    if (result?._tag !== "result") throw new Error("expected result frame");
    expect(result.envelope).toMatchObject({
      apiVersion: "v4",
      command: "app:logs",
      ok: true,
      result: { message: "done [redacted]" },
    });
  });

  test("buffered json streaming replays notify.desktop once without live stderr output", async () => {
    // Given: buffered JSON streaming with live event rendering disabled.
    const io = createBufferedRendererIO();

    // When: the command publishes a desktop notification.
    await runWithRendererHandling(
      Effect.gen(function* () {
        const events = yield* EventService;
        yield* events.publish({ _tag: "notify.desktop", title: "Done", urgency: "success" });
        return {};
      }),
      {
        runtime: Layer.empty,
        rendererMode: "json",
        resultFormat: "json",
        io,
        command: "app:logs",
        resultSchema: Schema.Struct({}),
        streaming: StreamFrame,
        renderEvents: false,
        render: () => undefined,
        formatError: () => "should not happen",
      },
    );

    // Then: history replay emits one event frame and the live stderr consumer stays silent.
    const frames = io.stdoutLines().map(decodeFrame);
    const notifications = frames.filter(
      (frame) => frame._tag === "event" && frame.event === "notify.desktop",
    );
    expect(notifications).toHaveLength(1);
    expect(io.stderr()).toBe("");
  });

  test("buffered json streaming replays failure notify.desktop once", async () => {
    // Given: buffered JSON streaming for a command that will fail.
    const io = createBufferedRendererIO();
    let exitCode: number | undefined;

    // When: the command publishes a failure notification before failing.
    await runWithRendererHandling(
      Effect.gen(function* () {
        const events = yield* EventService;
        yield* events.publish({ _tag: "notify.desktop", title: "Failed", urgency: "failure" });
        return yield* Effect.fail("boom");
      }),
      {
        runtime: Layer.empty,
        rendererMode: "json",
        resultFormat: "json",
        io,
        command: "app:logs",
        resultSchema: Schema.Struct({}),
        streaming: StreamFrame,
        renderEvents: false,
        render: () => undefined,
        formatError: String,
        setExitCode: (code) => {
          exitCode = code;
        },
      },
    );

    // Then: history replay emits one event frame before the failed result frame.
    const frames = io.stdoutLines().map(decodeFrame);
    expect(frames.map((frame) => frame._tag)).toEqual(["event", "result"]);
    const notification = frames[0];
    if (notification?._tag !== "event") throw new Error("expected event frame");
    expect(notification.event).toBe("notify.desktop");
    expect(io.stderr()).toBe("");
    expect(exitCode).toBe(1);
  });

  test("writes formatError to stderr and sets exitCode=1 on typed failure", async () => {
    const io = createBufferedRendererIO();
    let exitCode: number | undefined;
    await runWithRendererHandling(Effect.fail("boom"), {
      runtime: Layer.empty,
      rendererMode: "lando",
      io,
      formatError: (e) => `error: ${String(e)}`,
      setExitCode: (code) => {
        exitCode = code;
      },
    });
    expect(io.stderr()).toBe("error: boom\n");
    expect(io.stdout()).toBe("");
    expect(exitCode).toBe(1);
  });

  test("captures a runtime layer build failure as a diagnostic", async () => {
    const io = createBufferedRendererIO();
    let exitCode: number | undefined;
    const failingRuntime = Layer.effect(
      Renderer,
      Effect.fail("layer-build-failed"),
    ) as unknown as Layer.Layer<never, string>;
    await runWithRendererHandling(Effect.succeed("unreached"), {
      runtime: failingRuntime,
      rendererMode: "lando",
      io,
      formatError: (e) => `boot: ${String(e)}`,
      setExitCode: (code) => {
        exitCode = code;
      },
    });
    expect(io.stderr()).toContain("boot: layer-build-failed");
    expect(exitCode).toBe(1);
  });

  test("emits one deprecation warning per used warn surface and keeps the summary count", async () => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(
      Effect.gen(function* () {
        const deprecations = yield* DeprecationService;
        yield* deprecations.use({ kind: "command", id: "app:old", notice: warningNotice, timestamp });
        yield* deprecations.use({ kind: "command", id: "app:old", notice: warningNotice, timestamp });
        return "ok";
      }),
      {
        runtime: DeprecationServiceLive,
        rendererMode: "plain",
        io,
        render: (value) => value,
        formatError: () => "should not happen",
      },
    );

    expect(io.stdoutLines()).toEqual([
      "⚠ Deprecated command app:old (used 2 times): Use app:up instead. Replacement: app:up.",
      "ok",
    ]);
  });

  test("emits severity info deprecations as an end-of-run summary line", async () => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(
      Effect.gen(function* () {
        const deprecations = yield* DeprecationService;
        yield* deprecations.use({ kind: "config", id: "legacy.key", notice: infoNotice, timestamp });
      }),
      {
        runtime: DeprecationServiceLive,
        rendererMode: "plain",
        io,
        render: () => undefined,
        formatError: () => "should not happen",
      },
    );

    expect(io.stdoutLines()).toEqual(["ℹ Deprecated surfaces used: config legacy.key (1 use)."]);
  });

  test("suppresses only renderer warning output when requested", async () => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(
      Effect.gen(function* () {
        const deprecations = yield* DeprecationService;
        yield* deprecations.use({ kind: "command", id: "app:old", notice: warningNotice, timestamp });
        yield* deprecations.use({ kind: "config", id: "legacy.key", notice: infoNotice, timestamp });
        return yield* deprecations.summary();
      }),
      {
        runtime: DeprecationServiceLive,
        rendererMode: "plain",
        io,
        deprecationWarnings: false,
        render: (summary) => `summary=${summary.length}`,
        formatError: () => "should not happen",
      },
    );

    expect(io.stdoutLines()).toEqual(["ℹ Deprecated surfaces used: config legacy.key (1 use).", "summary=2"]);
  });

  test("json renderer emits structured deprecation-used diagnostics on stderr", async () => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(
      Effect.gen(function* () {
        const deprecations = yield* DeprecationService;
        yield* deprecations.use({ kind: "command", id: "app:old", notice: warningNotice, timestamp });
      }),
      {
        runtime: DeprecationServiceLive,
        rendererMode: "json",
        io,
        render: () => undefined,
        formatError: () => "should not happen",
      },
    );

    const event = decodeFrame(io.stderrLines()[0] ?? "{}");
    expect(event._tag).toBe("event");
    if (event._tag !== "event") throw new Error("expected event frame");
    expect(event.event).toBe("deprecation-used");
    expect(
      (event.payload as { readonly use?: { readonly id?: string; readonly count?: number } }).use?.id,
    ).toBe("app:old");
    expect((event.payload as { readonly use?: { readonly count?: number } }).use?.count).toBeUndefined();
  });
});

describe("resolveCliDeprecationWarnings", () => {
  test("strips --no-deprecation-warnings and disables renderer warnings", () => {
    expect(
      resolveCliDeprecationWarnings({
        argv: ["start", "--no-deprecation-warnings", "--renderer=json"],
        env: {},
      }),
    ).toEqual({ enabled: false, remainingArgv: ["start", "--renderer=json"] });
  });

  test("LANDO_DEPRECATION_WARNINGS=0 disables renderer warnings without changing argv", () => {
    expect(
      resolveCliDeprecationWarnings({ argv: ["start"], env: { LANDO_DEPRECATION_WARNINGS: "0" } }),
    ).toEqual({ enabled: false, remainingArgv: ["start"] });
  });

  test("preserves suppression-looking child args after the passthrough separator", () => {
    expect(
      resolveCliDeprecationWarnings({
        argv: ["exec", "--", "child", "--no-deprecation-warnings"],
        env: {},
      }),
    ).toEqual({ enabled: true, remainingArgv: ["exec", "--", "child", "--no-deprecation-warnings"] });
  });

  test("strips only suppression flags before the passthrough separator", () => {
    expect(
      resolveCliDeprecationWarnings({
        argv: ["exec", "--no-deprecation-warnings", "--", "child", "--no-deprecation-warnings"],
        env: {},
      }),
    ).toEqual({ enabled: false, remainingArgv: ["exec", "--", "child", "--no-deprecation-warnings"] });
  });
});

describe("write helpers", () => {
  test("writeResultLine appends a newline to stdout", () => {
    const io = createBufferedRendererIO();
    Effect.runSync(
      writeResultLine("hello").pipe(Effect.provide(makeRendererServiceLiveForMode("lando", io))),
    );
    expect(io.stdout()).toBe("hello\n");
  });

  test("writeDiagnosticLine appends a newline to stderr", () => {
    const io = createBufferedRendererIO();
    Effect.runSync(
      writeDiagnosticLine("oops").pipe(Effect.provide(makeRendererServiceLiveForMode("json", io))),
    );
    expect(io.stderr()).toBe("oops\n");
  });
});
