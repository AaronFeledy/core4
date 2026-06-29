import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Arbitrary, Effect, FastCheck, Schema } from "effect";

import { makeTestRuntime } from "@lando/core/testing";
import { CommandResultEnvelope, TunnelSession } from "@lando/sdk/schema";

import type { LandoCommandSpec } from "../../src/cli/oclif/command-base.ts";
import compiledCommands from "../../src/cli/oclif/compiled-commands.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";

const decodeEnvelope = (line: string): CommandResultEnvelope =>
  Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line));

const specFor = (id: string): LandoCommandSpec => {
  const commandClass = (compiledCommands as Record<string, { readonly landoSpec?: LandoCommandSpec }>)[id];
  const spec = commandClass?.landoSpec;
  if (spec === undefined) throw new Error(`No landoSpec for command id ${id}`);
  return spec;
};

interface DeferredCommandsFixture {
  readonly commands: ReadonlyArray<{ readonly id: string }>;
}

const deferredFixturePath = resolve(import.meta.dirname, "fixtures/deferred-commands.json");
const deferredCommandIds = (
  JSON.parse(readFileSync(deferredFixturePath, "utf-8")) as DeferredCommandsFixture
).commands.map((command) => command.id);

const tunnelSessionSample = Schema.decodeUnknownSync(TunnelSession)({
  id: "demo",
  app: "demo-app",
  provider: "demo-provider",
  target: { _tag: "service", service: "web", port: 80 },
  status: "ready",
  detached: false,
  startedAt: "2026-01-01T00:00:00.000Z",
});

const successValueFor = (spec: LandoCommandSpec): unknown => {
  if (spec.id === "app:share") return tunnelSessionSample;
  if (spec.id === "app:share:list") return [tunnelSessionSample];
  const arbitrary = Arbitrary.make(spec.resultSchema);
  const [sample] = FastCheck.sample(arbitrary, { numRuns: 1, seed: 7 });
  return sample;
};

const testRuntimeLayerFor = (spec: LandoCommandSpec) => {
  switch (spec.bootstrap) {
    case "app":
      return makeTestRuntime({ bootstrap: "app" }).layer;
    case "global":
      return makeTestRuntime({ bootstrap: "global" }).layer;
    case "provider":
      return makeTestRuntime({ bootstrap: "provider" }).layer;
    case "scratch":
      return makeTestRuntime({ bootstrap: "scratch" }).layer;
    case "commands":
    case "minimal":
    case "none":
    case "plugins":
    case "tooling":
      return makeTestRuntime({ bootstrap: "minimal" }).layer;
  }
};

const canonicalIds = Object.keys(compiledCommands).sort();

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("machine-output conformance", () => {
  test("enumerates every canonical command id and the deferred stubs", () => {
    expect(canonicalIds.length).toBeGreaterThan(0);
    expect(canonicalIds).toContain("app:start");
    expect(canonicalIds).toContain("meta:doctor");
    for (const id of deferredCommandIds) expect(canonicalIds).toContain(id);
  });

  test("every command emits a decodable success envelope under --format json", async () => {
    for (const id of canonicalIds) {
      const spec = specFor(id);
      const io = createBufferedRendererIO();
      const value = successValueFor(spec);
      await runWithRendererHandling(Effect.succeed(value), {
        runtime: testRuntimeLayerFor(spec),
        rendererMode: "json",
        resultFormat: "json",
        command: spec.id,
        resultSchema: spec.resultSchema,
        io,
        render: () => undefined,
        formatError: (error) => `diagnostic: ${String(error)}`,
      });
      const line = io.stdoutLines()[0] ?? "{}";
      const envelope = decodeEnvelope(line);
      expect(envelope.apiVersion).toBe("v4");
      expect(envelope.command).toBe(spec.id);
      expect(envelope.ok).toBe(true);
      expect(io.stderr()).toBe("");
    }
  });

  test("every command emits a decodable failure envelope with exit code 1", async () => {
    for (const id of canonicalIds) {
      const spec = specFor(id);
      const io = createBufferedRendererIO();
      let exitCode: number | undefined;
      await runWithRendererHandling(Effect.fail(new Error(`${spec.id} failed`)), {
        runtime: testRuntimeLayerFor(spec),
        rendererMode: "json",
        resultFormat: "json",
        command: spec.id,
        resultSchema: spec.resultSchema,
        io,
        formatError: (error) => `diagnostic: ${String(error)}`,
        setExitCode: (code) => {
          exitCode = code;
        },
      });
      const line = io.stdoutLines()[0] ?? "{}";
      const envelope = decodeEnvelope(line);
      expect(envelope.apiVersion).toBe("v4");
      expect(envelope.command).toBe(spec.id);
      expect(envelope.ok).toBe(false);
      expect(envelope.error).toBeDefined();
      expect(exitCode).toBe(1);
      expect(io.stderr()).toBe("");
    }
  });
});
