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

describe("compiled bootstrap lifecycle", () => {
  test("compiled dispatch emits the canonical minimal sequence", async () => {
    const compiled = makeRecordingHarness();
    setActiveCommandId(invocation.commandId);
    setActiveRendererMode("plain");
    setActiveResultFormat("text");
    resetActiveCommandInvocation(invocation.commandId, []);
    await runCompiledCommand(Effect.succeed({ ok: true }), runtimeFor(compiled.layer), () => undefined, {
      io: createBufferedRendererIO(),
      resultSchema,
    });

    const compiledTags = compiled.events.map((event) => event._tag);
    expect(compiledTags).toEqual([
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
    // Given: compiled dispatch receives the declared plugins runtime for a promoted command.
    const compiled = makeRecordingHarness();
    const updateInvocation = { ...invocation, commandId: "meta:update" };

    // When: compiled dispatch promotes execution to the commands runtime.
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

    // Then: promotion emits exactly one canonical commands lifecycle stream.
    const compiledTags = compiled.events.map((event) => event._tag);
    expect(compiledTags).toEqual([
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
