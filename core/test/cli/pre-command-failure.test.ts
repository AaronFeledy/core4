import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { Effect, Layer, Schema } from "effect";

import { ComposeKeyRejectedError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import type { EventService } from "@lando/sdk/services";
import { buildBugReport, renderJsonBugReport, renderPlainBugReport } from "../../src/cli/bug-report.ts";
import { MalformedCliFlagValueError } from "../../src/cli/flag-value-validation.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import { preCommandOutputMode, renderPreCommandFailure } from "../../src/cli/spec/command-boundary.ts";
import { makeRecordingHarness } from "./pre-command-failure-fixture.ts";

class PreCommandLayerError extends Schema.TaggedError<PreCommandLayerError>()("PreCommandLayerError", {
  message: Schema.String,
  remediation: Schema.String,
}) {}

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = 0;
});

describe("pre-command failure surface", () => {
  test("Compose rejection bug reports preserve structured context outside the machine envelope", () => {
    const remediation = "Move deploy.replicas to a provider extension.";
    const report = buildBugReport({
      error: new ComposeKeyRejectedError({
        message: "Compose key deploy.replicas is rejected.",
        source: "/workspace/.lando.yml",
        service: "web",
        keyPath: "deploy.replicas",
        remediation,
      }),
      context: { commandId: "app:start", cacheRoot: "/tmp/lando-cache" },
    });

    const plain = renderPlainBugReport(report);
    const json = JSON.parse(renderJsonBugReport(report)) as Record<string, unknown>;

    expect(plain).toContain("source: /workspace/.lando.yml");
    expect(plain).toContain("service: web");
    expect(plain).toContain("keyPath: deploy.replicas");
    expect(plain).toContain(remediation);
    expect(json).toMatchObject({
      source: "/workspace/.lando.yml",
      service: "web",
      keyPath: "deploy.replicas",
    });
  });

  test("Compose rejection bug reports visibly escape terminal controls only in plain output", () => {
    const source = "/workspace/\u001b[31m.lando.yml";
    const service = "web\u0007";
    const keyPath = "deploy.\u009breplicas";
    const report = buildBugReport({
      error: new ComposeKeyRejectedError({
        message: `Compose key ${keyPath} in ${source} is rejected.`,
        source,
        service,
        keyPath,
        remediation: "Use the matrix remediation.",
      }),
      context: { commandId: "app:start", cacheRoot: "/tmp/lando-cache" },
    });

    const plain = renderPlainBugReport(report);
    const json = JSON.parse(renderJsonBugReport(report)) as Record<string, unknown>;

    expect(plain).not.toContain("\u001b");
    expect(plain).not.toContain("\u0007");
    expect(plain).not.toContain("\u009b");
    expect(plain).toContain("\\u001b");
    expect(plain).toContain("\\u0007");
    expect(plain).toContain("\\u009b");
    expect(json).toMatchObject({ source, service, keyPath });
  });

  test("machine output intent includes flags before an absent argument terminator", () => {
    expect(
      preCommandOutputMode({
        argv: ["meta:version", "--renderer=private-value", "--format=json"],
        env: {},
      }),
    ).toEqual({ rendererMode: "json", resultFormat: "json" });
  });

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
