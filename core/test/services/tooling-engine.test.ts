import { describe, expect, test } from "bun:test";
import { Cause, DateTime, Effect, Exit, Stream } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import {
  type CommandSpec,
  type ExecResult,
  type ExecTarget,
  type RuntimeProviderShape,
  ToolingEngine,
  type ToolingInvocation,
} from "@lando/sdk/services";

import { ProviderExecToolingEngineLive } from "../../src/services/tooling-engine.ts";

const providerId = ProviderId.make("lando");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "tooling-engine.test",
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
  serviceHealth: "none" as const,
  hostReachability: "none" as const,
  sharedCrossAppNetwork: false,
  persistentStorage: false,
  bindMounts: false,
  bindMountPerformance: "none" as const,
  copyMounts: false,
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
    id: AppId.make("tooling-engine-test"),
    name: "tooling-engine-test",
    slug: "tooling-engine-test",
    root: AbsolutePath.make("/tmp/tooling-engine-test"),
    provider: providerId,
    services: map as AppPlan["services"],
    routes: [],
    networks: [],
    stores: [],
    metadata,
    extensions: {},
  };
};

interface ExecCall {
  readonly target: ExecTarget;
  readonly command: CommandSpec;
}

interface FakeProvider extends RuntimeProviderShape {
  readonly calls: ReadonlyArray<ExecCall>;
}

const makeFakeProvider = (
  responses: ReadonlyArray<ExecResult> | ((index: number) => ExecResult),
): FakeProvider => {
  const calls: ExecCall[] = [];
  const responseFor = (index: number): ExecResult =>
    typeof responses === "function"
      ? responses(index)
      : (responses[index] ?? { exitCode: 0, stdout: "", stderr: "" });
  const provider: RuntimeProviderShape = {
    id: providerId,
    displayName: "Fake provider",
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
    exec: (target, command) => {
      const index = calls.length;
      calls.push({ target, command });
      return Effect.succeed(responseFor(index));
    },
    execStream: () => Stream.empty,
    run: () => Effect.die("not used"),
    logs: () => Stream.empty,
    inspect: () => Effect.die("not used"),
    list: () => Effect.succeed([]),
  };
  Object.defineProperty(provider, "calls", { get: () => calls });
  return provider as FakeProvider;
};

const runEngine = (invocation: ToolingInvocation, plan: AppPlan, provider: RuntimeProviderShape) =>
  Effect.flatMap(ToolingEngine, (engine) => engine.run(invocation, plan, provider)).pipe(
    Effect.provide(ProviderExecToolingEngineLive),
  );

describe("ProviderExecToolingEngineLive", () => {
  test("Layer registers engine id 'providerExec'", async () => {
    const engine = await Effect.runPromise(ToolingEngine.pipe(Effect.provide(ProviderExecToolingEngineLive)));
    expect(engine.id).toBe("providerExec");
  });

  test("delegates to RuntimeProvider.exec with the declared service target", async () => {
    const plan = makePlan([baseServicePlan("web", true), baseServicePlan("worker")]);
    const provider = makeFakeProvider([{ exitCode: 0, stdout: "ok", stderr: "" }]);
    const invocation: ToolingInvocation = {
      tool: "composer",
      service: "worker",
      commands: [["composer", "install"]],
    };

    const result = await Effect.runPromise(runEngine(invocation, plan, provider));

    expect(provider.calls.length).toBe(1);
    expect(provider.calls[0]?.target.service).toBe(ServiceName.make("worker"));
    expect(provider.calls[0]?.target.app).toBe(plan.id);
    expect(provider.calls[0]?.target.plan).toBe(plan);
    expect(provider.calls[0]?.command.command).toEqual(["composer", "install"]);
    expect(result.tool).toBe("composer");
    expect(result.service).toBe(ServiceName.make("worker"));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
  });

  test("falls back to the primary service when service is not declared", async () => {
    const plan = makePlan([baseServicePlan("web", true), baseServicePlan("db")]);
    const provider = makeFakeProvider([{ exitCode: 0, stdout: "primary", stderr: "" }]);
    const invocation: ToolingInvocation = {
      tool: "phpunit",
      commands: [["phpunit"]],
    };

    const result = await Effect.runPromise(runEngine(invocation, plan, provider));

    expect(provider.calls[0]?.target.service).toBe(ServiceName.make("web"));
    expect(result.service).toBe(ServiceName.make("web"));
  });

  test("returns a tagged ToolingExecError when no service is declared and no primary exists", async () => {
    const plan = makePlan([baseServicePlan("db"), baseServicePlan("cache")]);
    const provider = makeFakeProvider([]);
    const invocation: ToolingInvocation = {
      tool: "phpunit",
      commands: [["phpunit"]],
    };

    const exit = await Effect.runPromiseExit(runEngine(invocation, plan, provider));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(provider.calls.length).toBe(0);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value._tag).toBe("ToolingExecError");
        expect(failure.value.message).toContain("no primary service");
      }
    }
  });

  test("returns a tagged ToolingExecError when the declared service does not exist", async () => {
    const plan = makePlan([baseServicePlan("web", true)]);
    const provider = makeFakeProvider([]);
    const invocation: ToolingInvocation = {
      tool: "composer",
      service: "missing",
      commands: [["composer"]],
    };

    const exit = await Effect.runPromiseExit(runEngine(invocation, plan, provider));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(provider.calls.length).toBe(0);
  });

  test("returns a tagged ToolingExecError when the declared service is an empty string", async () => {
    const plan = makePlan([baseServicePlan("web", true)]);
    const provider = makeFakeProvider([]);
    const invocation: ToolingInvocation = {
      tool: "composer",
      service: "",
      commands: [["composer"]],
    };

    const exit = await Effect.runPromiseExit(runEngine(invocation, plan, provider));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(provider.calls.length).toBe(0);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        expect(failure.value._tag).toBe("ToolingExecError");
        expect(failure.value.message).toContain("no such service");
      }
    }
  });

  test("runs commands sequentially, accumulates stdout/stderr, and stops at first non-zero exit", async () => {
    const plan = makePlan([baseServicePlan("web", true)]);
    const provider = makeFakeProvider([
      { exitCode: 0, stdout: "first\n", stderr: "" },
      { exitCode: 2, stdout: "second\n", stderr: "boom\n" },
      { exitCode: 0, stdout: "never\n", stderr: "" },
    ]);
    const invocation: ToolingInvocation = {
      tool: "build",
      commands: [
        ["sh", "-c", "first"],
        ["sh", "-c", "second"],
        ["sh", "-c", "third"],
      ],
    };

    const result = await Effect.runPromise(runEngine(invocation, plan, provider));

    expect(provider.calls.length).toBe(2);
    expect(provider.calls[0]?.command.command).toEqual(["sh", "-c", "first"]);
    expect(provider.calls[1]?.command.command).toEqual(["sh", "-c", "second"]);
    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("first\nsecond\n");
    expect(result.stderr).toBe("boom\n");
  });

  test("passes user/cwd/env overrides through to RuntimeProvider.exec", async () => {
    const plan = makePlan([baseServicePlan("web", true)]);
    const provider = makeFakeProvider([{ exitCode: 0, stdout: "", stderr: "" }]);
    const invocation: ToolingInvocation = {
      tool: "composer",
      user: "www-data",
      cwd: "/app/sub",
      env: { COMPOSER_CACHE_DIR: "/tmp/composer" },
      commands: [["composer", "install"]],
    };

    await Effect.runPromise(runEngine(invocation, plan, provider));

    expect(provider.calls[0]?.target.user).toBe("www-data");
    expect(provider.calls[0]?.command.cwd).toBe("/app/sub");
    expect(provider.calls[0]?.command.env).toEqual({ COMPOSER_CACHE_DIR: "/tmp/composer" });
  });

  test("returns a tagged ToolingExecError when the invocation has no commands", async () => {
    const plan = makePlan([baseServicePlan("web", true)]);
    const provider = makeFakeProvider([]);
    const invocation: ToolingInvocation = {
      tool: "nothing",
      commands: [],
    };

    const exit = await Effect.runPromiseExit(runEngine(invocation, plan, provider));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(provider.calls.length).toBe(0);
  });

  test("propagates ProviderError from RuntimeProvider.exec", async () => {
    const plan = makePlan([baseServicePlan("web", true)]);
    const provider: RuntimeProviderShape = {
      ...makeFakeProvider([]),
      exec: () =>
        Effect.fail(
          new (require("@lando/sdk/errors").ServiceExecError)({
            providerId,
            operation: "exec",
            service: ServiceName.make("web"),
            command: ["composer"],
            message: "exec failed in fake",
          }),
        ),
    };
    const invocation: ToolingInvocation = {
      tool: "composer",
      commands: [["composer"]],
    };

    const exit = await Effect.runPromiseExit(runEngine(invocation, plan, provider));

    expect(Exit.isFailure(exit)).toBe(true);
  });
});
