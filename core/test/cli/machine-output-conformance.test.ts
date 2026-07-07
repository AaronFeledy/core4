import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Arbitrary, Effect, FastCheck, Schema } from "effect";

import { makeTestRuntime } from "@lando/core/testing";
import { ScratchRunTargetError } from "@lando/sdk/errors";
import { CommandResultEnvelope, StreamFrame, TunnelSession } from "@lando/sdk/schema";

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

const appConfigResultCommandIds = new Set<string>([
  "app:config",
  "app:config:edit",
  "app:config:set",
  "app:config:unset",
  "app:config:validate",
]);

const successValueFor = (spec: LandoCommandSpec): unknown => {
  if (appConfigResultCommandIds.has(spec.id)) return {};
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

  describe("apps:scratch:run streaming", () => {
    const spec = specFor("apps:scratch:run");
    const decodeFrame = (line: string): StreamFrame =>
      Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line));

    const runScratchRunSpec = async (
      effect: Effect.Effect<unknown, unknown>,
      onExit?: (code: number) => void,
    ) => {
      const io = createBufferedRendererIO();
      await runWithRendererHandling(effect, {
        runtime: testRuntimeLayerFor(spec),
        rendererMode: "json",
        resultFormat: "json",
        command: spec.id,
        resultSchema: spec.resultSchema,
        ...(spec.streaming === undefined ? {} : { streaming: spec.streaming }),
        ...(spec.streamFrames === undefined ? {} : { streamFrames: spec.streamFrames }),
        ...(spec.redactionTokens === undefined ? {} : { redactionTokens: spec.redactionTokens }),
        ...(spec.successExitCode === undefined ? {} : { successExitCode: spec.successExitCode }),
        io,
        render: () => undefined,
        formatError: (error) => `diagnostic: ${String(error)}`,
        ...(onExit === undefined ? {} : { setExitCode: onExit }),
      });
      return io;
    };

    const successValue = (exitCode: number) => ({
      scratchId: "scratch-toolbox-test",
      service: "toolbox",
      command: ["echo", "ok"],
      exitCode,
      kept: false,
      stdout: "ok\n",
      stderr: "warn\n",
    });

    test("success emits stdout/stderr frames terminated by a result frame with scratch id and exit code", async () => {
      const io = await runScratchRunSpec(Effect.succeed(successValue(0)));
      const frames = io.stdoutLines().map(decodeFrame);
      expect(frames.map((frame) => frame._tag)).toEqual(["stdout", "stderr", "result"]);
      const [stdout, stderr, result] = frames;
      if (stdout?._tag !== "stdout" || stderr?._tag !== "stderr" || result?._tag !== "result") {
        throw new Error("unexpected frame sequence");
      }
      expect(stdout.chunk).toBe("ok\n");
      expect(stdout.service).toBe("toolbox");
      expect(stderr.chunk).toBe("warn\n");
      expect(result.envelope.ok).toBe(true);
      expect(result.envelope.command).toBe("apps:scratch:run");
      const payload = result.envelope.result as { scratchId: string; exitCode: number };
      expect(payload.scratchId).toBe("scratch-toolbox-test");
      expect(payload.exitCode).toBe(0);
      expect(io.stderr()).toBe("");
    });

    test("a tagged command failure emits a single result frame with ok:false and exit 1", async () => {
      let exitCode: number | undefined;
      const io = await runScratchRunSpec(
        Effect.fail(
          new ScratchRunTargetError({
            message: "Service nope is not defined by this recipe (available: toolbox).",
            service: "nope",
            available: ["toolbox"],
            remediation: "Pass --service with one of: toolbox.",
          }),
        ),
        (code) => {
          exitCode = code;
        },
      );
      const frames = io.stdoutLines().map(decodeFrame);
      expect(frames.map((frame) => frame._tag)).toEqual(["result"]);
      const [result] = frames;
      if (result?._tag !== "result") throw new Error("expected a result frame");
      expect(result.envelope.ok).toBe(false);
      const error = result.envelope.error as { _tag: string } | undefined;
      expect(error?._tag).toBe("ScratchRunTargetError");
      expect(exitCode).toBe(1);
    });

    test("a non-zero tool exit stays ok:true in the result frame and propagates the exit code", async () => {
      let exitCode: number | undefined;
      const io = await runScratchRunSpec(Effect.succeed(successValue(7)), (code) => {
        exitCode = code;
      });
      const frames = io.stdoutLines().map(decodeFrame);
      const result = frames.at(-1);
      if (result?._tag !== "result") throw new Error("expected a terminal result frame");
      expect(result.envelope.ok).toBe(true);
      const payload = result.envelope.result as { exitCode: number };
      expect(payload.exitCode).toBe(7);
      expect(exitCode).toBe(7);
    });

    test("forwarded agent env values are redacted from stream frames and the result envelope", async () => {
      const secret = "opencode-forwarded-secret";
      const io = await runScratchRunSpec(
        Effect.succeed({
          ...successValue(0),
          stdout: `out:${secret}\n`,
          stderr: `err:${secret}\n`,
          redactionTokens: [secret],
        }),
      );
      const output = io.stdout();
      expect(output).not.toContain(secret);
      expect(output).toContain("[redacted]");
      const frames = io.stdoutLines().map(decodeFrame);
      const [stdout, stderr, result] = frames;
      if (stdout?._tag !== "stdout" || stderr?._tag !== "stderr" || result?._tag !== "result") {
        throw new Error("unexpected frame sequence");
      }
      expect(stdout.chunk).toBe("out:[redacted]\n");
      expect(stderr.chunk).toBe("err:[redacted]\n");
      const payload = result.envelope.result as { readonly stdout: string; readonly stderr: string };
      expect(payload.stdout).toBe("out:[redacted]\n");
      expect(payload.stderr).toBe("err:[redacted]\n");
    });
  });
});
