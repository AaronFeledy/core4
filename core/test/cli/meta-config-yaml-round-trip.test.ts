import { expect, test } from "bun:test";
import { type ConfigResult, ConfigResultSchema } from "@lando/engine/operations/config";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { yamlRoundTripRecord } from "@lando/sdk/test";
import { Effect, Layer, Schema } from "effect";

import { metaConfigSpec } from "../../src/cli/command-specs/meta/config.ts";
import { renderConfigResult } from "../../src/cli/commands/config.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const yamlGet = (value: unknown): ConfigResult => ({
  subcommand: "get",
  format: "yaml",
  value,
});

test("config yaml output round-trips a record root through Bun.YAML.parse", async () => {
  // Given
  const value = {
    DB_PASSWORD: "[redacted]",
    colon: "a: b",
    star: "*anchor",
    ...yamlRoundTripRecord(),
  };
  // When
  const io = createBufferedRendererIO();
  await runWithRendererHandling(Effect.succeed(yamlGet(value)), {
    runtime: Layer.empty,
    rendererMode: "plain",
    resultFormat: "yaml",
    command: "meta:config",
    resultSchema: metaConfigSpec.resultSchema,
    io,
    render: () => undefined,
    formatError: String,
  });
  // Then
  const envelope = Schema.decodeUnknownSync(Schema.Struct({ result: ConfigResultSchema }))(
    Bun.YAML.parse(io.stdout()) as unknown,
  );
  expect(envelope.result.value).toEqual(value);
  expect(renderConfigResult(yamlGet(value))).toBe(renderConfigResult({ ...yamlGet(value), format: "table" }));
});

test("config yaml output round-trips a scalar root", async () => {
  // Given / When / Then
  for (const value of ["True", "a: b"]) {
    const io = createBufferedRendererIO();
    await runWithRendererHandling(Effect.succeed(yamlGet(value)), {
      runtime: Layer.empty,
      rendererMode: "plain",
      resultFormat: "yaml",
      command: "meta:config",
      resultSchema: metaConfigSpec.resultSchema,
      io,
      render: () => undefined,
      formatError: String,
    });
    const envelope = Schema.decodeUnknownSync(Schema.Struct({ result: ConfigResultSchema }))(
      Bun.YAML.parse(io.stdout()) as unknown,
    );
    expect(envelope.result.value).toBe(value);
  }
});

test("config yaml output round-trips an array root", async () => {
  // Given
  const value = ["True", "8080:80", 1, null];
  // When
  const io = createBufferedRendererIO();
  await runWithRendererHandling(Effect.succeed(yamlGet(value)), {
    runtime: Layer.empty,
    rendererMode: "plain",
    resultFormat: "yaml",
    command: "meta:config",
    resultSchema: metaConfigSpec.resultSchema,
    io,
    render: () => undefined,
    formatError: String,
  });
  // Then
  const envelope = Schema.decodeUnknownSync(Schema.Struct({ result: ConfigResultSchema }))(
    Bun.YAML.parse(io.stdout()) as unknown,
  );
  expect(envelope.result.value).toEqual(value);
});

test("dotted config keys stay plain and ambiguous keys are quoted", async () => {
  // Given
  const value = {
    "telemetry.enabled": true,
    "com.example.password": "secret",
    "dev.example.db-password": "secret",
    yes: "y",
  };
  // When
  const io = createBufferedRendererIO();
  await runWithRendererHandling(Effect.succeed(yamlGet(value)), {
    runtime: Layer.empty,
    rendererMode: "plain",
    resultFormat: "yaml",
    command: "meta:config",
    resultSchema: metaConfigSpec.resultSchema,
    io,
    render: () => undefined,
    formatError: String,
  });
  const rendered = io.stdout();
  // Then
  expect(rendered).toContain("telemetry.enabled:");
  expect(rendered).toContain('"yes":');
});
