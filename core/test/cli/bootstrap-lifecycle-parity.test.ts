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

const promotedRuntimeFor = (
  bootstrap: "plugins" | "commands",
  eventLayer: ReturnType<typeof makeRecordingHarness>["layer"],
) => makeLandoRuntime({ bootstrap, plugins: { layers: [eventLayer] } });

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

  test("compiled meta:update promotion emits one canonical commands sequence", async () => {
    // Given: source dispatch builds the effective commands runtime while compiled dispatch receives the declared plugins runtime.
    const source = makeRecordingHarness();
    const compiled = makeRecordingHarness();
    const updateInvocation = { ...invocation, commandId: "meta:update" };

    // When: both dispatch paths execute the promoted command.
    await runWithRendererHandling(Effect.succeed({ ok: true }), {
      runtime: promotedRuntimeFor("commands", source.layer),
      rendererMode: "plain",
      command: updateInvocation.commandId,
      invocation: updateInvocation,
      io: createBufferedRendererIO(),
      resultSchema,
      render: () => undefined,
      formatError: String,
    });
    setActiveCommandId(updateInvocation.commandId);
    setActiveRendererMode("plain");
    setActiveResultFormat("text");
    resetActiveCommandInvocation(updateInvocation.commandId, []);
    await runCompiledCommand(
      Effect.succeed({ ok: true }),
      promotedRuntimeFor("plugins", compiled.layer),
      () => undefined,
      {
        io: createBufferedRendererIO(),
        resultSchema,
        runtimeForBootstrap: () => promotedRuntimeFor("commands", compiled.layer),
      },
    );

    // Then: promotion has exactly the source path's single commands lifecycle stream.
    const sourceTags = source.events.map((event) => event._tag);
    const compiledTags = compiled.events.map((event) => event._tag);
    expect(compiledTags).toEqual(sourceTags);
    expect(sourceTags).toEqual([
      "pre-bootstrap-minimal",
      "post-bootstrap-minimal",
      "pre-bootstrap-plugins",
      "post-bootstrap-plugins",
      "pre-bootstrap-commands",
      "post-bootstrap-commands",
      "post-bootstrap",
      "ready",
      "cli-meta:update-init",
      "cli-meta:update-run",
      "before-exit",
    ]);
  });
});
