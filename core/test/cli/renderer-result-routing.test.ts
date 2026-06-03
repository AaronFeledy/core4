import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { Renderer } from "@lando/sdk/services";

import { makeRendererServiceLiveForMode, runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("command result vs message routing under --renderer=json", () => {
  test("a command result document is written to stdout, not stderr", async () => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(Effect.succeed({ ok: true }), {
      runtime: Layer.empty,
      rendererMode: "json",
      io,
      render: (value) => JSON.stringify(value),
      formatError: () => "unexpected",
    });
    expect(io.stdout()).toBe('{"ok":true}\n');
    expect(io.stderr()).toBe("");
    expect(process.exitCode).not.toBe(1);
  });

  test("a renderer message stays on stderr under json mode", () => {
    const io = createBufferedRendererIO();
    Effect.runSync(
      Effect.gen(function* () {
        const renderer = yield* Renderer;
        yield* renderer.message.info("progress: 1 of 3");
      }).pipe(Effect.provide(makeRendererServiceLiveForMode("json", io))),
    );
    expect(io.stderr()).toContain("progress: 1 of 3");
    expect(io.stdout()).toBe("");
  });

  test("a command failure diagnostic is written to stderr and exit code is 1", async () => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(Effect.fail("nope"), {
      runtime: Layer.empty,
      rendererMode: "json",
      io,
      formatError: (error) => `diagnostic: ${String(error)}`,
    });
    expect(io.stderr()).toBe("diagnostic: nope\n");
    expect(io.stdout()).toBe("");
    expect(process.exitCode).toBe(1);
  });
});
