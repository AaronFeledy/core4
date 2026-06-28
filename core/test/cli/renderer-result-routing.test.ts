import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Effect, Layer, Schema } from "effect";

import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Renderer } from "@lando/sdk/services";

import { makeRendererServiceLiveForMode, runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";

const decodeEnvelope = (line: string) => Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line));

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("command result vs message routing under --renderer=json", () => {
  test("a command result envelope is written to stdout, not stderr", async () => {
    const io = createBufferedRendererIO();
    let renderCalled = false;
    await runWithRendererHandling(Effect.succeed({ name: "demo" }), {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "json",
      command: "app:info",
      resultSchema: Schema.Struct({ name: Schema.String }),
      io,
      render: (value) => {
        renderCalled = true;
        return JSON.stringify(value);
      },
      formatError: () => "unexpected",
    });
    expect(decodeEnvelope(io.stdoutLines()[0] ?? "{}")).toMatchObject({
      apiVersion: "v4",
      command: "app:info",
      ok: true,
      result: { name: "demo" },
      warnings: [],
      deprecations: [],
    });
    expect(io.stderr()).toBe("");
    expect(renderCalled).toBe(false);
  });

  test("an explicit text result format uses the command renderer even when renderer mode is json", async () => {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(Effect.succeed({ name: "demo" }), {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "text",
      command: "app:info",
      resultSchema: Schema.Struct({ name: Schema.String }),
      io,
      render: (value) => `text:${(value as { name: string }).name}`,
      formatError: () => "unexpected",
    });
    expect(io.stdout()).toBe("text:demo\n");
    expect(io.stderr()).toBe("");
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

  test("a command failure envelope is written to stdout and exit code is 1", async () => {
    const io = createBufferedRendererIO();
    let exitCode: number | undefined;
    await runWithRendererHandling(Effect.fail("nope"), {
      runtime: Layer.empty,
      rendererMode: "json",
      resultFormat: "json",
      command: "app:start",
      io,
      formatError: (error) => `diagnostic: ${String(error)}`,
      setExitCode: (code) => {
        exitCode = code;
      },
    });
    const envelope = decodeEnvelope(io.stdoutLines()[0] ?? "{}");
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe("app:start");
    expect(envelope.error).toEqual({ _tag: "UnknownError", message: "nope" });
    expect(io.stderr()).toBe("");
    expect(exitCode).toBe(1);
  });
});
