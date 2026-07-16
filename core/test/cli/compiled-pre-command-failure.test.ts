import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Effect, Layer, Schema } from "effect";

import {
  clearActiveCommandInvocation,
  resetActiveCommandInvocation,
  runCompiledCommand,
  setActiveCommandId,
  setActiveRendererMode,
  setActiveResultFormat,
} from "../../src/cli/compiled-runtime.ts";
import { MalformedCliFlagValueError } from "../../src/cli/flag-value-validation.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import { makeRecordingHarness } from "./pre-command-failure-fixture.ts";

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

describe("compiled pre-command failure surface", () => {
  test("preCommand flag failure omits lifecycle even when an invocation was staged", async () => {
    const harness = makeRecordingHarness();
    const io = createBufferedRendererIO();
    setActiveCommandId("meta:version");
    setActiveRendererMode("json");
    setActiveResultFormat("json");
    resetActiveCommandInvocation("meta:version", ["--password=supersecret"]);

    const error = new MalformedCliFlagValueError({
      message: "Flag --format expects a value.",
      flag: "--format",
      issue: "missing",
      remediation: "Pass text or json.",
    });

    await runCompiledCommand(Effect.fail(error), harness.layer, () => undefined, {
      failureExitCode: () => 2,
      io,
      preCommand: true,
      resultSchema: Schema.Struct({}),
    });

    expect(harness.events.map((event) => event._tag)).toEqual([]);
    expect(JSON.parse(io.stdout().trim())).toMatchObject({
      apiVersion: "v4",
      command: "meta:version",
      ok: false,
      error: { _tag: "MalformedCliFlagValueError" },
    });
  });

  test("preCommand failures suppress inherited streaming framing", async () => {
    const io = createBufferedRendererIO();
    setActiveCommandId("app:logs");
    setActiveRendererMode("json");
    setActiveResultFormat("json");
    resetActiveCommandInvocation("app:logs", ["--tail=private-value"]);

    await runCompiledCommand(
      Effect.fail(
        new MalformedCliFlagValueError({
          message: "--tail has a malformed value.",
          flag: "tail",
          issue: "invalid_integer",
          remediation: "Supply --tail with a whole integer.",
        }),
      ),
      Layer.empty,
      () => undefined,
      { failureExitCode: () => 2, io, preCommand: true },
    );

    const output = JSON.parse(io.stdout().trim());
    expect(output).not.toHaveProperty("_tag");
    expect(output).toMatchObject({
      apiVersion: "v4",
      command: "app:logs",
      ok: false,
      error: { _tag: "MalformedCliFlagValueError" },
    });
  });

  test("flag failure with staged invocation publishes lifecycle without preCommand", async () => {
    const harness = makeRecordingHarness();
    const io = createBufferedRendererIO();
    setActiveCommandId("meta:version");
    setActiveResultFormat("json");
    resetActiveCommandInvocation("meta:version", ["--format"]);

    const error = new MalformedCliFlagValueError({
      message: "Flag --format expects a value.",
      flag: "--format",
      issue: "missing",
      remediation: "Pass text or json.",
    });

    await runCompiledCommand(Effect.fail(error), harness.layer, () => undefined, {
      failureExitCode: () => 2,
      io,
      resultSchema: Schema.Struct({}),
    });

    expect(harness.events.map((event) => event._tag)).toEqual([
      "cli-meta:version-init",
      "cli-meta:version-error",
    ]);
  });
});
