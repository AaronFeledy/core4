import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer } from "effect";

import type { DeprecationNotice } from "@lando/sdk/schema";
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

  test("emits one deprecation warning per used warn/error surface and keeps the summary count", async () => {
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
        return yield* deprecations.summary();
      }),
      {
        runtime: DeprecationServiceLive,
        rendererMode: "plain",
        io,
        deprecationWarnings: false,
        render: (summary) => `summary=${summary.length}:${summary[0]?.count}`,
        formatError: () => "should not happen",
      },
    );

    expect(io.stdout()).toBe("summary=1:1\n");
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

    const event = JSON.parse(io.stderrLines()[0] ?? "{}");
    expect(event._tag).toBe("deprecation-used");
    expect(event.use.id).toBe("app:old");
    expect(event.use.count).toBeUndefined();
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
