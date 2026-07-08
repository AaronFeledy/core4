import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Stream } from "effect";

import { ToolingExecError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type {
  ExecResult,
  RuntimeProviderShape,
  ToolingEngineResult,
  ToolingInvocation,
} from "@lando/sdk/services";
import {
  ContractFailure,
  type ToolingEngineContractHarness,
  type ToolingEngineUnderTest,
  makeToolingEngineContractSuite,
  runToolingEngineContractSuite,
} from "@lando/sdk/test";

const providerId = ProviderId.make("contract");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "tooling-engine.contract",
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
    id: AppId.make("tooling-contract"),
    name: "tooling-contract",
    slug: "tooling-contract",
    root: AbsolutePath.make("/tmp/tooling-contract"),
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

// A minimal synthetic engine mirroring the providerExec contract: run commands
// sequentially via provider.exec, stop at the first non-zero exit, fail with a
// tagged ToolingExecError when no commands are present.
const syntheticEngine: ToolingEngineUnderTest = {
  id: "synthetic",
  run: (invocation, plan, provider) =>
    Effect.gen(function* () {
      if (invocation.commands.length === 0) {
        return yield* Effect.fail(
          new ToolingExecError({
            message: `Tooling task ${invocation.tool} has no commands.`,
            tool: invocation.tool,
          }),
        );
      }
      const service = invocation.service ?? Object.values(plan.services)[0]?.name ?? ":primary";
      let exitCode = 0;
      let stdout = "";
      let stderr = "";
      for (const command of invocation.commands) {
        const result = yield* provider.exec(
          { app: plan.id, service: ServiceName.make(service), plan },
          { command },
        );
        stdout += result.stdout;
        stderr += result.stderr;
        exitCode = result.exitCode;
        if (exitCode !== 0) break;
      }
      const out: ToolingEngineResult = { tool: invocation.tool, service, exitCode, stdout, stderr };
      return out;
    }),
};

const okInvocation: ToolingInvocation = {
  tool: "build",
  service: "web",
  commands: [
    ["echo", "one"],
    ["echo", "two"],
  ],
};

const okExpected: ToolingEngineResult = {
  tool: "build",
  service: "web",
  exitCode: 0,
  stdout: "one\ntwo\n",
  stderr: "",
};

const makeHarness = (engine: ToolingEngineUnderTest): ToolingEngineContractHarness => ({
  name: `${engine.id}`,
  engine,
  okScenario: {
    invocation: okInvocation,
    plan: makePlan([baseServicePlan("web", true)]),
    makeProvider: () =>
      makeRecordingProvider([
        { exitCode: 0, stdout: "one\n", stderr: "" },
        { exitCode: 0, stdout: "two\n", stderr: "" },
      ]),
    expected: okExpected,
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
});

describe("ToolingEngine contract", () => {
  test("the synthetic providerExec-shaped engine passes the contract", async () => {
    const exit = await Effect.runPromiseExit(runToolingEngineContractSuite(makeHarness(syntheticEngine)));
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("optional capability, interruption, and redaction probes pass when supplied", async () => {
    const secret = "s3cr3t-token";
    const exit = await Effect.runPromiseExit(
      runToolingEngineContractSuite({
        ...makeHarness(syntheticEngine),
        capabilities: ["serviceExec"],
        behaviorTags: ["serviceExec"],
        interruptionProbe: {
          invocation: { tool: "sleep", service: "web", commands: [["sleep"]] },
          plan: makePlan([baseServicePlan("web", true)]),
          provider: {
            ...makeRecordingProvider([]).provider,
            exec: () => Effect.never,
          },
          // A never-resolving exec is interrupted by Effect's scope; nothing to
          // clean up, so finalization is trivially satisfied.
          assertFinalized: Effect.succeed(true),
        },
        redactionProbe: {
          invocation: { tool: "build", service: "web", commands: [["echo", "ok"]] },
          plan: makePlan([baseServicePlan("web", true)]),
          // The provider never echoes the secret back into stdout/stderr.
          makeProvider: () => makeRecordingProvider([{ exitCode: 0, stdout: "ok\n", stderr: "" }]),
          secretValue: secret,
          render: (result) => `${result.stdout}${result.stderr}`,
        },
      }),
    );
    if (exit._tag === "Failure") {
      throw new Error(`Contract failure: ${JSON.stringify(exit.cause, null, 2)}`);
    }
    expect(exit._tag).toBe("Success");
  });

  test("an engine that ignores command order fails the contract", async () => {
    const reordering: ToolingEngineUnderTest = {
      id: "reordering",
      run: (invocation, plan, provider) =>
        Effect.gen(function* () {
          const service = invocation.service ?? "web";
          // Runs the commands in REVERSE order, violating the ordering guarantee.
          for (const command of [...invocation.commands].reverse()) {
            yield* provider.exec({ app: plan.id, service: ServiceName.make(service), plan }, { command });
          }
          const out: ToolingEngineResult = {
            tool: invocation.tool,
            service,
            exitCode: 0,
            stdout: "one\ntwo\n",
            stderr: "",
          };
          return out;
        }),
    };
    const exit = await Effect.runPromiseExit(runToolingEngineContractSuite(makeHarness(reordering)));
    expect(exit._tag).toBe("Failure");
  });

  test("an engine that does not short-circuit on non-zero exit fails the contract", async () => {
    const noShortCircuit: ToolingEngineUnderTest = {
      id: "noShortCircuit",
      run: (invocation, plan, provider) =>
        Effect.gen(function* () {
          const service = invocation.service ?? "web";
          let exitCode = 0;
          let stdout = "";
          let stderr = "";
          for (const command of invocation.commands) {
            const result = yield* provider.exec(
              { app: plan.id, service: ServiceName.make(service), plan },
              { command },
            );
            stdout += result.stdout;
            stderr += result.stderr;
            exitCode = result.exitCode;
            // Intentionally never breaks on a non-zero exit.
          }
          const out: ToolingEngineResult = { tool: invocation.tool, service, exitCode, stdout, stderr };
          return out;
        }),
    };
    const exit = await Effect.runPromiseExit(runToolingEngineContractSuite(makeHarness(noShortCircuit)));
    expect(exit._tag).toBe("Failure");
  });

  test("makeToolingEngineContractSuite is an alias", () => {
    expect(makeToolingEngineContractSuite).toBe(runToolingEngineContractSuite);
  });

  test("ContractFailure is exported", () => {
    expect(ContractFailure).toBeDefined();
  });
});
