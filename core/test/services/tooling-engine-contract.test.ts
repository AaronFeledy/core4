import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Stream } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { type ExecResult, type RuntimeProviderShape, ToolingEngine } from "@lando/sdk/services";
import { type ToolingEngineContractHarness, runToolingEngineContractSuite } from "@lando/sdk/test";

import { HostToolingEngineLive } from "../../src/services/host-tooling-engine.ts";
import { ProviderExecToolingEngineLive } from "../../src/services/tooling-engine.ts";

const providerId = ProviderId.make("lando");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "tooling-engine-contract.test",
  runtime: 4 as const,
};

const stubCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: false,
  serviceExec: true,
  serviceLogs: false,
  serviceLogSources: false,
  serviceHealth: "none" as const,
  hostReachability: "none" as const,
  sharedCrossAppNetwork: false,
  persistentStorage: false,
  bindMounts: false,
  bindMountPerformance: "none" as const,
  copyMounts: false,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none" as const,
  serviceFileCopy: "none" as const,
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
  hostPortPublish: "none" as const,
  routeProvider: false,
  tlsCertificates: "none" as const,
  rootless: true,
  privilegedServices: false,
  composeSpec: "none" as const,
  providerExtensions: [],
};

const baseServicePlan = (name: string, primary = false): ServicePlan => ({
  name: ServiceName.make(name),
  type: "node",
  provider: providerId,
  primary,
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const makePlan = (services: ReadonlyArray<ServicePlan>): AppPlan => {
  const map: Record<string, ServicePlan> = {};
  for (const service of services) map[service.name] = service;
  return {
    id: AppId.make("tooling-engine-contract"),
    name: "tooling-engine-contract",
    slug: "tooling-engine-contract",
    root: AbsolutePath.make("/tmp/tooling-engine-contract"),
    provider: providerId,
    services: map as AppPlan["services"],
    routes: [],
    networks: [],
    stores: [],
    metadata,
    extensions: {},
  };
};

interface RecordingProvider {
  readonly provider: RuntimeProviderShape;
  readonly record: () => ReadonlyArray<ReadonlyArray<string>>;
}

const makeRecordingProvider = (
  responses: ReadonlyArray<ExecResult> | ((index: number) => ExecResult),
): RecordingProvider => {
  const calls: Array<ReadonlyArray<string>> = [];
  const responseFor = (index: number): ExecResult =>
    typeof responses === "function"
      ? responses(index)
      : (responses[index] ?? { exitCode: 0, stdout: "", stderr: "" });
  const provider: RuntimeProviderShape = {
    id: providerId,
    displayName: "Recording provider",
    version: "0.0.0",
    platform: "linux",
    capabilities: stubCapabilities,
    isAvailable: Effect.succeed(true),
    setup: () => Effect.void,
    getStatus: Effect.succeed({ running: true }),
    getVersions: Effect.succeed({ provider: "0.0.0" }),
    buildArtifact: () => Effect.die("not used"),
    pullArtifact: () => Effect.die("not used"),
    removeArtifact: () => Effect.void,
    apply: () => Effect.succeed({ changed: false }),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    destroy: () => Effect.void,
    exec: (_target, command) => {
      const index = calls.length;
      calls.push(command.command);
      return Effect.succeed(responseFor(index));
    },
    execStream: () => Stream.empty,
    run: () => Effect.die("not used"),
    logs: () => Stream.empty,
    inspect: () => Effect.die("not used"),
    list: () => Effect.succeed([]),
  };
  return { provider, record: () => calls };
};

// A provider that never delegates exec; the host engine ignores the provider.
const inertProvider: RuntimeProviderShape = {
  ...makeRecordingProvider([]).provider,
  exec: () => Effect.die("host engine must not call provider exec"),
};

const runEngineLayer = (live: typeof ProviderExecToolingEngineLive) =>
  Effect.runPromise(ToolingEngine.pipe(Effect.provide(live)));

describe("ToolingEngine contract — built-in engines", () => {
  test("the built-in providerExec engine passes the contract", async () => {
    const engine = await runEngineLayer(ProviderExecToolingEngineLive);
    const harness: ToolingEngineContractHarness = {
      name: "providerExec",
      engine,
      okScenario: {
        invocation: {
          tool: "build",
          service: "web",
          commands: [
            ["echo", "one"],
            ["echo", "two"],
          ],
        },
        plan: makePlan([baseServicePlan("web", true)]),
        makeProvider: () =>
          makeRecordingProvider([
            { exitCode: 0, stdout: "one\n", stderr: "" },
            { exitCode: 0, stdout: "two\n", stderr: "" },
          ]),
        expected: {
          tool: "build",
          service: ServiceName.make("web"),
          exitCode: 0,
          stdout: "one\ntwo\n",
          stderr: "",
        },
        expectedCommands: [
          ["echo", "one"],
          ["echo", "two"],
        ],
      },
      failScenario: {
        invocation: {
          tool: "build",
          service: "web",
          commands: [["echo", "first"], ["false"], ["echo", "never"]],
        },
        plan: makePlan([baseServicePlan("web", true)]),
        makeProvider: () =>
          makeRecordingProvider([
            { exitCode: 0, stdout: "first\n", stderr: "" },
            { exitCode: 3, stdout: "", stderr: "boom\n" },
            { exitCode: 0, stdout: "never\n", stderr: "" },
          ]),
        expectedExitCode: 3,
        expectedCommandCount: 2,
      },
      execErrorScenario: {
        invocation: { tool: "empty", commands: [] },
        plan: makePlan([baseServicePlan("web", true)]),
        provider: makeRecordingProvider([]).provider,
      },
      capabilities: ["serviceExec"],
      behaviorTags: ["serviceExec"],
    };
    const exit = await Effect.runPromiseExit(runToolingEngineContractSuite(harness));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure (providerExec): ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("the built-in host engine passes the contract (host-safe shell commands)", async () => {
    const engine = await runEngineLayer(HostToolingEngineLive);
    // The host engine runs real shell commands on the host, so the recording
    // provider is inert (the engine ignores it) and the assertions use the host
    // shell's own output. `expectedCommands` is empty because the host engine
    // never delegates to provider.exec.
    const plan = makePlan([baseServicePlan("web", true)]);
    const harness: ToolingEngineContractHarness = {
      name: "host",
      engine,
      okScenario: {
        invocation: {
          tool: "build",
          service: "web",
          commands: [
            ["sh", "-c", "printf one"],
            ["sh", "-c", "printf two"],
          ],
        },
        plan,
        makeProvider: () => ({ provider: inertProvider, record: () => [] }),
        expected: {
          tool: "build",
          service: ServiceName.make("web"),
          exitCode: 0,
          stdout: "onetwo",
          stderr: "",
        },
        expectedCommands: [],
      },
      failScenario: {
        invocation: {
          tool: "build",
          service: "web",
          commands: [
            ["sh", "-c", "printf first"],
            ["sh", "-c", "exit 3"],
            ["sh", "-c", "printf never"],
          ],
        },
        plan,
        makeProvider: () => ({ provider: inertProvider, record: () => [] }),
        expectedExitCode: 3,
        // Host engine does not record provider calls; the short-circuit is proved
        // by the fail scenario's exit code (3, not the third command's 0).
        expectedCommandCount: 0,
      },
      execErrorScenario: {
        invocation: { tool: "empty", commands: [] },
        plan,
        provider: inertProvider,
      },
    };
    const exit = await Effect.runPromiseExit(runToolingEngineContractSuite(harness));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure (host): ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });
});
