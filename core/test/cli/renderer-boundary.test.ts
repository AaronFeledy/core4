import { afterEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { Renderer } from "@lando/sdk/services";

import {
  makeRendererServiceLiveForMode,
  runWithRendererHandling,
  writeDiagnosticLine,
  writeResultLine,
} from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";

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
    expect(process.exitCode).toBeUndefined();
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

  test("writes formatError to stderr and sets exitCode=1 on typed failure", async () => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(Effect.fail("boom"), {
      runtime: Layer.empty,
      rendererMode: "lando",
      io,
      formatError: (e) => `error: ${String(e)}`,
    });
    expect(io.stderr()).toBe("error: boom\n");
    expect(io.stdout()).toBe("");
    expect(process.exitCode).toBe(1);
  });

  test("captures a runtime layer build failure as a diagnostic", async () => {
    const io = createBufferedRendererIO();
    const failingRuntime = Layer.effect(
      Renderer,
      Effect.fail("layer-build-failed"),
    ) as unknown as Layer.Layer<never, string>;
    await runWithRendererHandling(Effect.succeed("unreached"), {
      runtime: failingRuntime,
      rendererMode: "lando",
      io,
      formatError: (e) => `boot: ${String(e)}`,
    });
    expect(io.stderr()).toContain("boot: layer-build-failed");
    expect(process.exitCode).toBe(1);
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
