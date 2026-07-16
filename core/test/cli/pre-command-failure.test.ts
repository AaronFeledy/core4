import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Effect, Layer, Queue, Schema, Stream } from "effect";

import { LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import { EventService, type EventServiceShape, type LandoEvent } from "@lando/sdk/services";

import {
  resetActiveCommandInvocation,
  runCompiledCommand,
  setActiveCommandId,
  setActiveResultFormat,
} from "../../src/cli/compiled-runtime.ts";
import { MalformedCliFlagValueError } from "../../src/cli/flag-value-validation.ts";
import { renderPreCommandFailure } from "../../src/cli/oclif/command-boundary.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";

class PreCommandLayerError extends Schema.TaggedError<PreCommandLayerError>()("PreCommandLayerError", {
  message: Schema.String,
  remediation: Schema.String,
}) {}

type RecordingHarness = {
  readonly events: Array<LandoEvent>;
  readonly layer: Layer.Layer<EventService>;
};

const makeRecordingHarness = (): RecordingHarness => {
  const events: Array<LandoEvent> = [];
  const service: EventServiceShape = {
    publish: (event) =>
      Effect.sync(() => {
        events.push(event);
      }),
    subscribe: () => Stream.empty,
    subscribeQueue: Effect.gen(function* () {
      const queue = yield* Queue.unbounded<LandoEvent>();
      yield* Effect.addFinalizer(() => Queue.shutdown(queue));
      return queue;
    }),
    waitFor: () => Effect.never,
    waitForAny: () => Effect.never,
    query: () => Effect.succeed(events),
  };
  return {
    events,
    layer: Layer.succeed(EventService, service),
  };
};

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe("pre-command failure surface", () => {
  test("pre-parse validation emits a machine envelope without lifecycle events", async () => {
    const harness = makeRecordingHarness();
    const io = createBufferedRendererIO();
    let exitCode: number | undefined;
    const error = new MalformedCliFlagValueError({
      message: "Flag --tail expects an integer value.",
      flag: "--tail",
      issue: "invalid_integer",
      remediation: "Pass a whole number, for example --tail 100.",
    });

    await runWithRendererHandling(Effect.fail(error), {
      runtime: harness.layer,
      rendererMode: "json",
      resultFormat: "json",
      command: "app:logs",
      resultSchema: Schema.Struct({}),
      io,
      failureExitCode: () => 2,
      formatError: String,
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    expect(exitCode).toBe(2);
    expect(JSON.parse(io.stdout().trim())).toMatchObject({
      apiVersion: "v4",
      command: "app:logs",
      ok: false,
      error: {
        _tag: "MalformedCliFlagValueError",
        message: "Flag --tail expects an integer value.",
        remediation: "Pass a whole number, for example --tail 100.",
      },
    });
    expect(harness.events.map((event) => event._tag)).toEqual([]);
  });

  test("compiled preCommand flag failure omits lifecycle even when an invocation was staged", async () => {
    const harness = makeRecordingHarness();
    setActiveCommandId("meta:version");
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
      preCommand: true,
      resultSchema: Schema.Struct({}),
    });

    expect(harness.events.map((event) => event._tag)).toEqual([]);
  });

  test("compiled flag failure with staged invocation publishes lifecycle without preCommand", async () => {
    const harness = makeRecordingHarness();
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
      resultSchema: Schema.Struct({}),
    });

    expect(harness.events.map((event) => event._tag)).toEqual([
      "cli-meta:version-init",
      "cli-meta:version-error",
    ]);
  });

  test("runtime-layer construction failure emits a machine envelope without lifecycle events", async () => {
    const harness = makeRecordingHarness();
    const io = createBufferedRendererIO();
    let exitCode: number | undefined;
    const bootstrapError = new LandoRuntimeBootstrapError({
      message: "Failed to construct the app runtime layer.",
      stage: "app",
    });
    const failingRuntime = Layer.fail(bootstrapError) as Layer.Layer<never, LandoRuntimeBootstrapError>;

    await runWithRendererHandling(Effect.succeed("unreached"), {
      runtime: Layer.merge(failingRuntime, harness.layer) as Layer.Layer<
        EventService,
        LandoRuntimeBootstrapError
      >,
      rendererMode: "json",
      resultFormat: "json",
      command: "app:start",
      resultSchema: Schema.Struct({}),
      io,
      formatError: (error) => String(error),
      setExitCode: (code) => {
        exitCode = code;
      },
    });

    expect(exitCode).toBe(1);
    expect(JSON.parse(io.stdout().trim())).toMatchObject({
      apiVersion: "v4",
      command: "app:start",
      ok: false,
      error: {
        _tag: "LandoRuntimeBootstrapError",
        message: "Failed to construct the app runtime layer.",
      },
    });
    expect(harness.events.map((event) => event._tag)).toEqual([]);
  });

  test("runtime-layer construction failure redacts secret-bearing diagnostics", async () => {
    const io = createBufferedRendererIO();
    const previous = process.env.BUN_AUTH_TOKEN;
    process.env.BUN_AUTH_TOKEN = "layer-secret-token";
    try {
      const failingRuntime = Layer.fail(
        new PreCommandLayerError({
          message: "boot failed with layer-secret-token",
          remediation: "Unset BUN_AUTH_TOKEN=layer-secret-token and retry.",
        }),
      ) as Layer.Layer<never, PreCommandLayerError>;

      await runWithRendererHandling(Effect.succeed("unreached"), {
        runtime: failingRuntime,
        rendererMode: "plain",
        io,
        formatError: (error) => {
          const record = error as PreCommandLayerError;
          return `${record.message}\n  ↳ ${record.remediation}`;
        },
        setExitCode: () => undefined,
      });
    } finally {
      if (previous === undefined) {
        process.env.BUN_AUTH_TOKEN = undefined;
      } else {
        process.env.BUN_AUTH_TOKEN = previous;
      }
    }

    expect(io.stderr()).toContain("[redacted]");
    expect(io.stderr()).not.toContain("layer-secret-token");
  });

  test("pre-command text failures stay non-zero and secret-free", async () => {
    const io = createBufferedRendererIO();
    let exitCode: number | undefined;
    const previous = process.env.NPM_TOKEN;
    process.env.NPM_TOKEN = "argv-secret-value";
    try {
      await renderPreCommandFailure({
        commandId: "app:logs",
        error: new MalformedCliFlagValueError({
          message: "Flag --tail expects an integer value near NPM_TOKEN=argv-secret-value.",
          flag: "--tail",
          issue: "invalid_integer",
          remediation: "Pass a whole number.",
        }),
        rendererMode: "plain",
        resultFormat: "text",
        failureExitCode: 2,
        io,
        setExitCode: (code) => {
          exitCode = code;
        },
      });
    } finally {
      if (previous === undefined) {
        process.env.NPM_TOKEN = undefined;
      } else {
        process.env.NPM_TOKEN = previous;
      }
    }

    expect(exitCode).toBe(2);
    expect(io.stderr()).toContain("MalformedCliFlagValueError");
    expect(io.stderr()).not.toContain("argv-secret-value");
  });
});
