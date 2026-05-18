import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer, Stream } from "effect";

import { runTooling } from "@lando/core/cli/operations";
import { ProviderUnavailableError } from "@lando/core/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type LandofileShape,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/core/schema";
import {
  AppPlanner,
  LandofileService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/core/services";

import { ProviderExecToolingEngineLive } from "../../src/services/tooling-engine.ts";

const providerId = ProviderId.make("lando");

const capabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-18T00:00:00Z"),
  source: "tooling.scenario.test",
  runtime: 4 as const,
};

const makeService = (name: string, primary = false): ServicePlan => ({
  name: ServiceName.make(name),
  type: "node",
  provider: providerId,
  primary,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: undefined,
  entrypoint: undefined,
  environment: {},
  user: undefined,
  workingDirectory: undefined,
  appMount: undefined,
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  healthcheck: undefined,
  certs: undefined,
  hostAliases: [],
  metadata,
  extensions: {},
});

const makePlan = (services: ReadonlyArray<ServicePlan>): AppPlan => ({
  id: AppId.make("scenario"),
  name: "scenario",
  slug: "scenario",
  root: AbsolutePath.make("/tmp/scenario"),
  provider: providerId,
  services: Object.fromEntries(
    services.map((service) => [String(service.name), service]),
  ) as AppPlan["services"],
  routes: [],
  networks: [],
  stores: [],
  metadata,
  extensions: {},
});

interface ExecRecord {
  readonly service: string;
  readonly command: ReadonlyArray<string>;
}

const makeProvider = (
  responses: ReadonlyArray<{ exitCode: number; stdout?: string; stderr?: string }>,
): { provider: RuntimeProviderShape; calls: ReadonlyArray<ExecRecord> } => {
  const calls: ExecRecord[] = [];
  let i = 0;
  const provider: RuntimeProviderShape = {
    id: providerId,
    displayName: "Fake",
    version: "0.0.0",
    platform: "linux",
    capabilities,
    isAvailable: Effect.succeed(true),
    setup: () => Effect.void,
    getStatus: Effect.succeed({ running: true }),
    getVersions: Effect.succeed({ provider: "0.0.0" }),
    buildArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId,
          operation: "buildArtifact",
          message: "n/a",
        }),
      ),
    pullArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId,
          operation: "pullArtifact",
          message: "n/a",
        }),
      ),
    removeArtifact: () => Effect.void,
    apply: () => Effect.succeed({ changed: false }),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    destroy: () => Effect.void,
    exec: (target, spec) => {
      calls.push({ service: String(target.service), command: spec.command });
      const response = responses[i] ?? { exitCode: 0 };
      i += 1;
      return Effect.succeed({
        exitCode: response.exitCode,
        stdout: response.stdout ?? "",
        stderr: response.stderr ?? "",
      });
    },
    execStream: () => Stream.empty,
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    logs: () => Stream.empty,
    inspect: () =>
      Effect.fail(new ProviderUnavailableError({ providerId, operation: "inspect", message: "n/a" })),
    list: () => Effect.succeed([]),
  };
  return { provider, calls };
};

const makeLayer = (options: {
  readonly landofile: LandofileShape;
  readonly plan: AppPlan;
  readonly provider: RuntimeProviderShape;
}) => {
  const landofileLayer = Layer.succeed(LandofileService, {
    discover: Effect.succeed(options.landofile),
  });
  const plannerLayer = Layer.succeed(AppPlanner, {
    plan: () => Effect.succeed(options.plan),
  });
  const registryLayer = Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(capabilities),
    select: () => Effect.succeed(options.provider),
  });
  return Layer.mergeAll(landofileLayer, plannerLayer, registryLayer, ProviderExecToolingEngineLive);
};

const runtimeFor = (layer: Layer.Layer<never, never, never>) => Effect.provide(layer);

describe("runTooling — CLI rendering", () => {
  test("returns the verbatim exit code, stdout, and stderr from RuntimeProvider.exec", async () => {
    const plan = makePlan([makeService("appserver", true)]);
    const { provider, calls } = makeProvider([{ exitCode: 5, stdout: "out-1\nout-2\n", stderr: "err-1\n" }]);
    const landofile: LandofileShape = {
      name: "scenario",
      tooling: { composer: { service: "appserver", cmd: "composer" } },
    };
    const layer = makeLayer({ landofile, plan, provider });

    const result = await Effect.runPromise(
      runTooling({ name: "composer", args: ["install"] }).pipe(runtimeFor(layer)),
    );

    expect(result.tool).toBe("composer");
    expect(result.service).toBe("appserver");
    expect(result.exitCode).toBe(5);
    expect(result.stdout).toBe("out-1\nout-2\n");
    expect(result.stderr).toBe("err-1\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.service).toBe("appserver");
    expect(calls[0]?.command).toEqual(["sh", "-c", "composer install"]);
  });

  test("appends pass-through args to argv-form cmd", async () => {
    const plan = makePlan([makeService("appserver", true)]);
    const { provider, calls } = makeProvider([{ exitCode: 0 }]);
    const landofile: LandofileShape = {
      name: "scenario",
      tooling: {
        phpunit: {
          service: "appserver",
          cmd: ["phpunit", "--colors=always"],
        },
      },
    };
    const layer = makeLayer({ landofile, plan, provider });

    await Effect.runPromise(runTooling({ name: "phpunit", args: ["--testdox"] }).pipe(runtimeFor(layer)));

    expect(calls[0]?.command).toEqual(["phpunit", "--colors=always", "--testdox"]);
  });

  test("runs each entry in cmds: sequentially under sh -c, appending args to the last entry only", async () => {
    const plan = makePlan([makeService("appserver", true)]);
    const { provider, calls } = makeProvider([
      { exitCode: 0, stdout: "install-out\n" },
      { exitCode: 0, stdout: "test-out\n" },
    ]);
    const landofile: LandofileShape = {
      name: "scenario",
      tooling: {
        test: {
          service: "appserver",
          cmds: ["composer install", "phpunit"],
        },
      },
    };
    const layer = makeLayer({ landofile, plan, provider });

    const result = await Effect.runPromise(
      runTooling({ name: "test", args: ["--testdox"] }).pipe(runtimeFor(layer)),
    );

    expect(calls.map((call) => call.command)).toEqual([
      ["sh", "-c", "composer install"],
      ["sh", "-c", "phpunit --testdox"],
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("install-out\ntest-out\n");
  });

  test("fails fast with ToolingCompileError on unknown tooling command", async () => {
    const plan = makePlan([makeService("appserver", true)]);
    const { provider, calls } = makeProvider([{ exitCode: 0 }]);
    const landofile: LandofileShape = {
      name: "scenario",
      tooling: { composer: { service: "appserver", cmd: "composer" } },
    };
    const layer = makeLayer({ landofile, plan, provider });

    const exit = await Effect.runPromiseExit(runTooling({ name: "missing" }).pipe(runtimeFor(layer)));

    expect(exit._tag).toBe("Failure");
    expect(calls).toHaveLength(0);
    if (exit._tag !== "Failure") return;
    const flat = JSON.stringify(exit.cause);
    expect(flat).toContain("ToolingCompileError");
    expect(flat).toContain("missing");
  });

  test("fails with ToolingExecError when the task has neither cmd nor cmds", async () => {
    const plan = makePlan([makeService("appserver", true)]);
    const { provider, calls } = makeProvider([{ exitCode: 0 }]);
    const landofile: LandofileShape = {
      name: "scenario",
      tooling: { empty: { service: "appserver" } },
    };
    const layer = makeLayer({ landofile, plan, provider });

    const exit = await Effect.runPromiseExit(runTooling({ name: "empty" }).pipe(runtimeFor(layer)));

    expect(exit._tag).toBe("Failure");
    expect(calls).toHaveLength(0);
  });

  test("writes captured stderr to process.stderr so CLI users see it verbatim", async () => {
    const plan = makePlan([makeService("appserver", true)]);
    const { provider } = makeProvider([{ exitCode: 1, stdout: "", stderr: "boom\n" }]);
    const landofile: LandofileShape = {
      name: "scenario",
      tooling: { composer: { service: "appserver", cmd: "composer" } },
    };
    const layer = makeLayer({ landofile, plan, provider });

    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((
      chunk: string | Uint8Array,
    ) => {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = await Effect.runPromise(runTooling({ name: "composer" }).pipe(runtimeFor(layer)));
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toBe("boom\n");
      expect(writes.join("")).toContain("boom\n");
    } finally {
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = originalWrite;
    }
  });

  test("resolves to the primary service when the task does not declare service:", async () => {
    const plan = makePlan([makeService("web", true), makeService("database")]);
    const { provider, calls } = makeProvider([{ exitCode: 0 }]);
    const landofile: LandofileShape = {
      name: "scenario",
      tooling: { test: { cmd: "bun test" } },
    };
    const layer = makeLayer({ landofile, plan, provider });

    await Effect.runPromise(runTooling({ name: "test" }).pipe(runtimeFor(layer)));

    expect(calls[0]?.service).toBe("web");
  });

  test("fails with ToolingExecError when the task does not declare service: and the app has no primary", async () => {
    const plan = makePlan([makeService("database"), makeService("cache")]);
    const { provider } = makeProvider([{ exitCode: 0 }]);
    const landofile: LandofileShape = {
      name: "scenario",
      tooling: { test: { cmd: "bun test" } },
    };
    const layer = makeLayer({ landofile, plan, provider });

    const exit = await Effect.runPromiseExit(runTooling({ name: "test" }).pipe(runtimeFor(layer)));

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect(JSON.stringify(exit.cause)).toContain("ToolingExecError");
  });
});
