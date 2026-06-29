import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Arbitrary, Effect, FastCheck, Layer, Schema } from "effect";

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

const canonicalIds = Object.keys(compiledCommands).sort();

beforeEach(() => {
  process.exitCode = undefined;
});

afterEach(() => {
  process.exitCode = undefined;
});

describe("§13.1 machine-output conformance", () => {
  test("enumerates every canonical command id and the deferred stubs", () => {
    expect(canonicalIds.length).toBeGreaterThan(0);
    expect(canonicalIds).toContain("app:start");
    expect(canonicalIds).toContain("meta:doctor");
    expect(canonicalIds).toContain("meta:global:list");
  });

  test("every command emits a decodable success envelope under --format json", async () => {
    for (const id of canonicalIds) {
      const spec = specFor(id);
      const io = createBufferedRendererIO();
      const value = successValueFor(spec);
      await runWithRendererHandling(Effect.succeed(value), {
        runtime: Layer.empty,
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
        runtime: Layer.empty,
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
