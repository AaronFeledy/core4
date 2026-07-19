import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import {
  clearActiveCommandInvocation,
  resetActiveCommandInvocation,
  runCompiledCommand,
  setActiveCommandId,
  setActiveRendererMode,
  setActiveResultFormat,
} from "../../src/cli/compiled-runtime.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import { makeLandoRuntime } from "../../src/runtime/layer.ts";
import { makeRecordingHarness } from "./pre-command-failure-fixture.ts";

const resultSchema = Schema.Struct({ ok: Schema.Boolean });
const invocation = {
  commandId: "meta:config",
  argv: [],
  args: {},
  flags: {},
  cwd: "/workspace/demo",
} as const;

const runtimeFor = (eventLayer: ReturnType<typeof makeRecordingHarness>["layer"]) =>
  makeLandoRuntime({ bootstrap: "minimal", plugins: { layers: [eventLayer] } });

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
  setActiveCommandId("cli:unknown");
  setActiveRendererMode("lando");
  setActiveResultFormat("text");
  clearActiveCommandInvocation();
});

describe("bootstrap lifecycle dispatch parity", () => {
  test("source and compiled dispatch emit the same minimal sequence", async () => {
    const source = makeRecordingHarness();
    await runWithRendererHandling(Effect.succeed({ ok: true }), {
      runtime: runtimeFor(source.layer),
      rendererMode: "plain",
      command: invocation.commandId,
      invocation,
      io: createBufferedRendererIO(),
      resultSchema,
      render: () => undefined,
      formatError: String,
    });

    const compiled = makeRecordingHarness();
    setActiveCommandId(invocation.commandId);
    setActiveRendererMode("plain");
    setActiveResultFormat("text");
    resetActiveCommandInvocation(invocation.commandId, []);
    await runCompiledCommand(Effect.succeed({ ok: true }), runtimeFor(compiled.layer), () => undefined, {
      io: createBufferedRendererIO(),
      resultSchema,
    });

    const sourceTags = source.events.map((event) => event._tag);
    const compiledTags = compiled.events.map((event) => event._tag);
    expect(compiledTags).toEqual(sourceTags);
    expect(sourceTags).toEqual([
      "pre-bootstrap-minimal",
      "post-bootstrap-minimal",
      "post-bootstrap",
      "ready",
      "cli-meta:config-init",
      "cli-meta:config-run",
      "before-exit",
    ]);
  });
});
