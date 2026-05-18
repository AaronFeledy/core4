import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer, Stream } from "effect";

import { execApp } from "@lando/core/cli/operations";
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
  source: "exec.scenario.test",
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
  readonly user?: string;
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
      Effect.fail(new ProviderUnavailableError({ providerId, operation: "buildArtifact", message: "n/a" })),
    pullArtifact: () =>
      Effect.fail(new ProviderUnavailableError({ providerId, operation: "pullArtifact", message: "n/a" })),
    removeArtifact: () => Effect.void,
    apply: () => Effect.succeed({ changed: false }),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    destroy: () => Effect.void,
    exec: (target, spec) => {
      calls.push({
        service: String(target.service),
        command: spec.command,
        ...(target.user === undefined ? {} : { user: target.user }),
      });
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
}) =>
  Layer.mergeAll(
    Layer.succeed(LandofileService, { discover: Effect.succeed(options.landofile) }),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(options.plan) }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(capabilities),
      select: () => Effect.succeed(options.provider),
    }),
  );

describe("execApp — provider-exec scenarios (US-022)", () => {
  test("returns verbatim exit code, stdout, and stderr from RuntimeProvider.exec", async () => {
    const plan = makePlan([makeService("appserver", true)]);
    const { provider, calls } = makeProvider([{ exitCode: 5, stdout: "ok-1\nok-2\n", stderr: "warn\n" }]);
    const landofile: LandofileShape = { name: "scenario" };

    const result = await Effect.runPromise(
      execApp({ service: "appserver", command: ["ls", "/srv"] }).pipe(
        Effect.provide(makeLayer({ landofile, plan, provider })),
      ),
    );

    expect(result.app).toBe("scenario");
    expect(result.service).toBe("appserver");
    expect(result.command).toEqual(["ls", "/srv"]);
    expect(result.exitCode).toBe(5);
    expect(result.stdout).toBe("ok-1\nok-2\n");
    expect(result.stderr).toBe("warn\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.service).toBe("appserver");
    expect(calls[0]?.command).toEqual(["ls", "/srv"]);
  });

  test("resolves to the primary service when --service is omitted", async () => {
    const plan = makePlan([makeService("web", true), makeService("database")]);
    const { provider, calls } = makeProvider([{ exitCode: 0, stdout: "" }]);

    await Effect.runPromise(
      execApp({ command: ["whoami"] }).pipe(
        Effect.provide(makeLayer({ landofile: { name: "scenario" }, plan, provider })),
      ),
    );

    expect(calls[0]?.service).toBe("web");
    expect(calls[0]?.command).toEqual(["whoami"]);
  });

  test("fails with ToolingExecError when the requested service is unknown", async () => {
    const plan = makePlan([makeService("web", true), makeService("database")]);
    const { provider, calls } = makeProvider([{ exitCode: 0 }]);

    const exit = await Effect.runPromiseExit(
      execApp({ service: "missing", command: ["ls"] }).pipe(
        Effect.provide(makeLayer({ landofile: { name: "scenario" }, plan, provider })),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(calls).toHaveLength(0);
    if (exit._tag !== "Failure") return;
    const flat = JSON.stringify(exit.cause);
    expect(flat).toContain("ToolingExecError");
    expect(flat).toContain("missing");
    expect(flat).toContain("web");
  });

  test("fails when no service is given and the app has no primary", async () => {
    const plan = makePlan([makeService("web"), makeService("database")]);
    const { provider, calls } = makeProvider([{ exitCode: 0 }]);

    const exit = await Effect.runPromiseExit(
      execApp({ command: ["ls"] }).pipe(
        Effect.provide(makeLayer({ landofile: { name: "scenario" }, plan, provider })),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(calls).toHaveLength(0);
    if (exit._tag !== "Failure") return;
    expect(JSON.stringify(exit.cause)).toContain("exec requires --service");
  });

  test("fails with ToolingExecError on empty command", async () => {
    const plan = makePlan([makeService("web", true)]);
    const { provider, calls } = makeProvider([]);

    const exit = await Effect.runPromiseExit(
      execApp({ command: [] }).pipe(
        Effect.provide(makeLayer({ landofile: { name: "scenario" }, plan, provider })),
      ),
    );

    expect(exit._tag).toBe("Failure");
    expect(calls).toHaveLength(0);
  });

  test("threads --user through to provider.exec", async () => {
    const plan = makePlan([makeService("appserver", true)]);
    const { provider, calls } = makeProvider([{ exitCode: 0 }]);

    await Effect.runPromise(
      execApp({ service: "appserver", user: "www-data", command: ["id"] }).pipe(
        Effect.provide(makeLayer({ landofile: { name: "scenario" }, plan, provider })),
      ),
    );

    expect(calls[0]?.user).toBe("www-data");
  });

  test("writes captured stderr to process.stderr so the CLI user sees it verbatim", async () => {
    const plan = makePlan([makeService("appserver", true)]);
    const { provider } = makeProvider([{ exitCode: 1, stdout: "", stderr: "boom\n" }]);

    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
    (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((
      chunk: string | Uint8Array,
    ) => {
      writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = await Effect.runPromise(
        execApp({ service: "appserver", command: ["sh", "-c", "exit 1"] }).pipe(
          Effect.provide(makeLayer({ landofile: { name: "scenario" }, plan, provider })),
        ),
      );
      expect(result.exitCode).toBe(1);
      expect(writes.join("")).toContain("boom\n");
    } finally {
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = originalWrite;
    }
  });
});
