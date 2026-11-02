import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Arbitrary, Effect, Option, Schema } from "effect";

import { makeTestRuntime } from "@lando/core/testing";
import type { AppConfigResult } from "@lando/engine/operations/app-config-result";
import type { GlobalPolicyChangeResult } from "@lando/engine/operations/global-policy";
import type { LogsAppResult } from "@lando/engine/operations/logs";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { RedactionService } from "@lando/redaction/service";
import { ScratchRunTargetError } from "@lando/sdk/errors";
import { CommandResultEnvelope, LandofileShape, StreamFrame, TunnelSession } from "@lando/sdk/schema";

import { createBufferedRendererIO } from "@lando/renderer/io";
import { builtInCommandEntries, resolveBuiltInCommand } from "../../src/cli/built-in-command-registry.ts";
import { compiledCommandTransportOptions } from "../../src/cli/compiled-runtime.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { compiledCommandOptionsFromSpec } from "../../src/cli/run-built-in-command.ts";
import type { LandoCommandSpec } from "../../src/cli/spec/command-base.ts";

const decodeEnvelope = (line: string): CommandResultEnvelope =>
  Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(line));

const transportFor = (spec: LandoCommandSpec) =>
  compiledCommandTransportOptions(spec, compiledCommandOptionsFromSpec(spec, {}).streamingMode);

const terminalEnvelope = (spec: LandoCommandSpec, lines: ReadonlyArray<string>): CommandResultEnvelope => {
  const transport = transportFor(spec);
  if (transport.streaming === undefined && transport.streamingMode !== "live") {
    expect(lines).toHaveLength(1);
    return decodeEnvelope(lines[0] ?? "{}");
  }
  const frames = lines.map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line)));
  expect(frames.filter((frame) => frame._tag === "result")).toHaveLength(1);
  const terminal = frames.at(-1);
  if (terminal?._tag !== "result") throw new Error(`Missing terminal result frame for ${spec.id}`);
  return Schema.decodeUnknownSync(CommandResultEnvelope)(terminal.envelope);
};

const specFor = (id: string): LandoCommandSpec => {
  const spec = resolveBuiltInCommand(id)?.spec;
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

// Avoid arbitrary generation of the large Landofile schema. Match each app-config
// producer, including the default full resolved view, rather than any union member.
const appConfigSuccessValues = new Map<string, AppConfigResult>([
  [
    "app:config",
    {
      source: "resolved",
      app: "demo-app",
      sources: [],
      landofile: Schema.decodeUnknownSync(LandofileShape)({ name: "demo-app", services: {} }),
    },
  ],
  [
    "app:config:edit",
    { subcommand: "edit", filePath: "/demo/.lando.yml", changed: true, valid: true, dryRun: false },
  ],
  [
    "app:config:set",
    {
      subcommand: "set",
      filePath: "/demo/.lando.yml",
      key: "name",
      value: "demo-app",
      changed: true,
      dryRun: false,
    },
  ],
  [
    "app:config:unset",
    { subcommand: "unset", filePath: "/demo/.lando.yml", key: "x-note", changed: true, dryRun: false },
  ],
  ["app:config:validate", { subcommand: "validate", filePath: "/demo/.lando.yml", valid: true, issues: [] }],
]);
// GlobalConfigResultSchema still has only optional fields, so {} remains valid.
const globalConfigResultCommandIds = new Set<string>([
  "meta:global:config",
  "meta:global:config:edit",
  "meta:global:config:set",
  "meta:global:config:unset",
  "meta:global:config:validate",
]);

// Large nested policy results exhaust the YAML-safe arbitrary filter; use valid no-op previews.
const globalPolicySuccessValues = new Map<string, GlobalPolicyChangeResult>(
  (["enable", "disable", "reconcile"] as const).map((operation) => [
    `meta:global:${operation}`,
    {
      operation,
      dryRun: true,
      revision: 1,
      policySaved: false,
      contributions: [],
      plugins: [],
      states: [],
      servicesRemoved: [],
      pending: [],
      impact: {
        desired: operation === "reconcile" ? "unchanged" : operation === "enable" ? "enabled" : "disabled",
        policyChanges: false,
        contributions: [],
        plugins: [],
        dependencyBlockers: [],
        consumers: [],
        allowDisruption: false,
        routes: [],
        volumes: "retained",
        uncertainties: [],
        validationErrors: [],
      },
    },
  ]),
);

// Effect 4's string arbitrary can emit lone surrogates, which no YAML document can carry.
const isWellFormedDeep = (value: unknown): boolean => {
  if (typeof value === "string") return value.isWellFormed();
  if (Array.isArray(value)) return value.every(isWellFormedDeep);
  if (value !== null && typeof value === "object") {
    return Object.entries(value).every(([key, entry]) => key.isWellFormed() && isWellFormedDeep(entry));
  }
  return true;
};

const successValueFor = (spec: LandoCommandSpec): unknown => {
  const appConfigValue = appConfigSuccessValues.get(spec.id);
  if (appConfigValue !== undefined) return appConfigValue;
  if (globalConfigResultCommandIds.has(spec.id)) return {};
  const globalPolicyValue = globalPolicySuccessValues.get(spec.id);
  if (globalPolicyValue !== undefined) return globalPolicyValue;
  if (spec.id === "app:share") return tunnelSessionSample;
  if (spec.id === "app:share:list") return [tunnelSessionSample];
  if (spec.id === "app:logs" || spec.id === "meta:global:logs") {
    return {
      app: "demo-app",
      lines: [{ service: "web", stream: "stdout", line: "ready" }],
    } satisfies LogsAppResult;
  }
  const arbitrary = Arbitrary.schema(spec.resultSchema).pipe(Arbitrary.filter(isWellFormedDeep));
  const [sample] = Effect.runSync(Arbitrary.sampleEffect(arbitrary, { count: 1, seed: 7 }));
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

const canonicalIds = builtInCommandEntries.map((entry) => entry.spec.id).sort();

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
        ...transportFor(spec),
        io,
        render: () => undefined,
        formatError: ({ error }) => `diagnostic: ${String(error)}`,
      });
      const envelope = terminalEnvelope(spec, io.stdoutLines());
      expect(envelope.apiVersion).toBe("v4");
      expect(envelope.command).toBe(spec.id);
      expect(envelope.ok, `${spec.id}: ${JSON.stringify(envelope.error)}`).toBe(true);
      expect(io.stderr()).toBe("");
    }
  });

  test("every command emits a yaml envelope carrying the same model as its json envelope", async () => {
    for (const id of canonicalIds) {
      const spec = specFor(id);
      const value = successValueFor(spec);
      const emit = async (resultFormat: "json" | "yaml") => {
        const io = createBufferedRendererIO();
        await runWithRendererHandling(Effect.succeed(value), {
          runtime: testRuntimeLayerFor(spec),
          rendererMode: "json",
          resultFormat,
          command: spec.id,
          resultSchema: spec.resultSchema,
          ...transportFor(spec),
          io,
          render: () => undefined,
          formatError: ({ error }) => `diagnostic: ${String(error)}`,
        });
        return io;
      };

      const jsonIo = await emit("json");
      const yamlIo = await emit("yaml");
      const jsonEnvelope = terminalEnvelope(spec, jsonIo.stdoutLines());
      const yamlValue = Bun.YAML.parse(yamlIo.stdout());
      const yamlEnvelope = Schema.decodeUnknownSync(CommandResultEnvelope)(yamlValue);
      expect(jsonEnvelope.ok, `${spec.id}: ${JSON.stringify(jsonEnvelope.error)}`).toBe(true);
      expect(yamlEnvelope.ok).toBe(true);
      expect(yamlValue).toEqual(jsonEnvelope);
      expect(yamlIo.stderr()).toBe("");
    }
  });

  test("every command emits a yaml failure envelope matching its json failure envelope", async () => {
    for (const id of canonicalIds) {
      const spec = specFor(id);
      const emit = async (resultFormat: "json" | "yaml") => {
        const io = createBufferedRendererIO();
        let exitCode: number | undefined;
        await runWithRendererHandling(Effect.fail(new Error(`${spec.id} failed`)), {
          runtime: testRuntimeLayerFor(spec),
          rendererMode: "json",
          resultFormat,
          command: spec.id,
          resultSchema: spec.resultSchema,
          ...transportFor(spec),
          io,
          formatError: ({ error }) => `diagnostic: ${String(error)}`,
          setExitCode: (code) => {
            exitCode = code;
          },
        });
        return { io, exitCode };
      };

      const json = await emit("json");
      const yaml = await emit("yaml");
      const jsonEnvelope = terminalEnvelope(spec, json.io.stdoutLines());
      const yamlValue = Bun.YAML.parse(yaml.io.stdout());
      Schema.decodeUnknownSync(CommandResultEnvelope)(yamlValue);
      expect(yamlValue).toEqual(jsonEnvelope);
      expect(yaml.exitCode).toBe(json.exitCode);
      expect(yaml.io.stderr()).toBe("");
    }
  });

  test("projectResultKeys narrows envelope.result through runWithRendererHandling", async () => {
    // Given version success output and a single projection key.
    const spec = specFor("meta:version");
    const io = createBufferedRendererIO();
    const value = successValueFor(spec) as { readonly core: string };

    // When the renderer boundary emits with projectResultKeys.
    await runWithRendererHandling(Effect.succeed(value), {
      runtime: testRuntimeLayerFor(spec),
      rendererMode: "json",
      resultFormat: "json",
      command: spec.id,
      resultSchema: spec.resultSchema,
      projectResultKeys: ["core"],
      io,
      render: () => undefined,
      formatError: ({ error }) => `diagnostic: ${String(error)}`,
    });

    // Then the envelope result contains only that key.
    const envelope = decodeEnvelope(io.stdoutLines()[0] ?? "{}");
    expect(envelope.ok).toBe(true);
    expect(envelope.result).toEqual({ core: value.core });
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
        ...transportFor(spec),
        io,
        formatError: ({ error }) => `diagnostic: ${String(error)}`,
        setExitCode: (code) => {
          exitCode = code;
        },
      });
      const envelope = terminalEnvelope(spec, io.stdoutLines());
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
        ...transportFor(spec),
        ...(spec.redactionTokens === undefined ? {} : { redactionTokens: spec.redactionTokens }),
        ...(spec.completion === undefined
          ? {}
          : {
              completion: (value: unknown) =>
                spec.completion?.(value, {}) ?? { ok: true as const, exitCode: 0 },
            }),
        io,
        render: () => undefined,
        formatError: ({ error }) => `diagnostic: ${String(error)}`,
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

    // The command streams chunks through the live sink as the tool produces them, then returns its result.
    const streamedResult = (value: ReturnType<typeof successValue> & { redactionTokens?: string[] }) =>
      Effect.gen(function* () {
        const redaction = yield* Effect.serviceOption(RedactionService);
        if (Option.isSome(redaction)) yield* redaction.value.registerValues(value.redactionTokens ?? []);
        const sink = yield* Effect.serviceOption(StreamFrameSink);
        if (Option.isSome(sink)) {
          yield* sink.value.emit({ _tag: "stdout", chunk: value.stdout, kind: "bytes" });
          yield* sink.value.emit({ _tag: "stderr", chunk: value.stderr, kind: "bytes" });
        }
        return value;
      });

    test("success emits stdout/stderr frames terminated by a result frame with scratch id and exit code", async () => {
      const io = await runScratchRunSpec(streamedResult(successValue(0)));
      const frames = io.stdoutLines().map(decodeFrame);
      expect(frames.map((frame) => frame._tag)).toEqual(["stdout", "stderr", "result"]);
      const [stdout, stderr, result] = frames;
      if (stdout?._tag !== "stdout" || stderr?._tag !== "stderr" || result?._tag !== "result") {
        throw new Error("unexpected frame sequence");
      }
      expect(stdout.chunk).toBe("ok\n");
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

    test("a non-zero tool exit retains the failed result and propagates the exit code", async () => {
      let exitCode: number | undefined;
      const io = await runScratchRunSpec(streamedResult(successValue(7)), (code) => {
        exitCode = code;
      });
      const frames = io.stdoutLines().map(decodeFrame);
      const result = frames.at(-1);
      if (result?._tag !== "result") throw new Error("expected a terminal result frame");
      expect(result.envelope.ok).toBe(false);
      const payload = result.envelope.result as { exitCode: number };
      expect(payload.exitCode).toBe(7);
      expect(exitCode).toBe(7);
    });

    test("forwarded agent env values are redacted from stream frames and the result envelope", async () => {
      const secret = "opencode-forwarded-secret";
      const io = await runScratchRunSpec(
        streamedResult({
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
