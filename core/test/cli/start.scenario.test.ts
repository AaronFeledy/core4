import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DateTime, Effect, Layer, Stream } from "effect";

import { renderStartAppResult, startApp } from "@lando/core/cli/operations";
import { ProviderUnavailableError } from "@lando/core/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/core/schema";
import { AppPlanner, EventService, LandofileService, RuntimeProviderRegistry } from "@lando/core/services";
import type { RuntimeProviderShape } from "@lando/sdk/services";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");
const providerId = ProviderId.make("lando");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

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
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "start.scenario.test",
  runtime: 4 as const,
};

const servicePlan = (name: "web" | "database"): ServicePlan => ({
  name: ServiceName.make(name),
  type: name === "web" ? "node" : "postgres",
  provider: providerId,
  primary: name === "web",
  artifact: { kind: "ref", ref: name === "web" ? "node:22-alpine" : "postgres:16-alpine" },
  command: name === "web" ? ["node", "server.js"] : ["postgres"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints:
    name === "web"
      ? [{ port: 3000, protocol: "http", name: "http" }]
      : [{ port: 5432, protocol: "tcp", name: "database" }],
  routes: [],
  dependsOn: name === "web" ? [{ service: ServiceName.make("database"), condition: "started" }] : [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const web = servicePlan("web");
const database = servicePlan("database");
const plan: AppPlan = {
  id: AppId.make("test-start"),
  name: "test-start",
  slug: "test-start",
  root: AbsolutePath.make("/tmp/test-start"),
  provider: providerId,
  services: { [web.name]: web, [database.name]: database },
  routes: [],
  networks: [],
  stores: [],
  metadata,
  extensions: {},
};

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-start-scenario-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const runCli = async (args: ReadonlyArray<string>, cwd: string): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);

  return { exitCode, stdout, stderr };
};

const makeStartLayer = (options: { readonly signalSeen?: boolean[] } = {}) => {
  const events: string[] = [];
  const applyPlans: AppPlan[] = [];
  const provider: RuntimeProviderShape = {
    id: "lando",
    displayName: "Lando Runtime Provider",
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
          providerId: "lando",
          operation: "buildArtifact",
          message: "unavailable",
        }),
      ),
    pullArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "pullArtifact",
          message: "unavailable",
        }),
      ),
    removeArtifact: () => Effect.void,
    apply: (appPlan, applyOptions) =>
      Effect.sync(() => {
        applyPlans.push(appPlan);
        options.signalSeen?.push(applyOptions.signal?.aborted ?? false);
      }).pipe(Effect.as({ changed: true })),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    destroy: () => Effect.void,
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    execStream: () => Stream.die("not used"),
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    logs: () => Stream.die("not used"),
    inspect: (target) =>
      Effect.succeed({
        app: plan.id,
        service: target.service,
        providerId,
        status: "running",
        state: "running",
        endpoints: plan.services[target.service]?.endpoints ?? [],
      }),
    list: () => Effect.succeed([]),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(LandofileService, { discover: Effect.succeed({ name: "test-start", services: {} }) }),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(capabilities),
      select: () => Effect.succeed(provider),
    }),
    Layer.succeed(EventService, {
      publish: (event) => Effect.sync(() => events.push(event._tag)),
      subscribe: () => Effect.die("not used"),
      waitFor: () => Effect.die("not used"),
    }),
  );

  return { layer, events, applyPlans };
};

describe("lando start", () => {
  test("plans the app, applies provider-lando, publishes app events, and renders ready services", async () => {
    const harness = makeStartLayer();
    const result = await Effect.runPromise(startApp().pipe(Effect.provide(harness.layer)));

    expect(harness.events).toEqual(["pre-app-start", "post-app-start"]);
    expect(harness.applyPlans).toEqual([plan]);
    expect(result.servicesStarted.map((service) => [service.name, service.state])).toEqual([
      ["web", "running"],
      ["database", "running"],
    ]);
    expect(renderStartAppResult(result)).toContain("ready: test-start");
    expect(renderStartAppResult(result)).toContain("web (running) http://localhost:3000");
    expect(renderStartAppResult(result)).toContain("database (running) tcp://localhost:5432");
  });

  test("renders starting: prefix when any service is not in a ready state per inspect", () => {
    const stoppedResult: Parameters<typeof renderStartAppResult>[0] = {
      app: "test-start",
      servicesStarted: [
        {
          name: "web",
          state: "stopped",
          endpoints: ["http://localhost:3000"],
        },
        {
          name: "database",
          state: "running",
          endpoints: ["tcp://localhost:5432"],
        },
      ],
    };

    const rendered = renderStartAppResult(stoppedResult);

    expect(rendered).toContain("starting: test-start");
    expect(rendered).not.toContain("ready: test-start");
    expect(rendered).toContain("web (stopped)");
    expect(rendered).toContain("database (running)");
  });

  test("renders ready: prefix when every service reports ready state per inspect", () => {
    const readyResult: Parameters<typeof renderStartAppResult>[0] = {
      app: "test-start",
      servicesStarted: [
        {
          name: "web",
          state: "ready",
          endpoints: ["http://localhost:3000"],
        },
        {
          name: "database",
          state: "running",
          endpoints: ["tcp://localhost:5432"],
        },
      ],
    };

    const rendered = renderStartAppResult(readyResult);

    expect(rendered).toContain("ready: test-start");
    expect(rendered).toContain("web (ready)");
    expect(rendered).toContain("database (running)");
  });

  test("passes an AbortSignal to provider apply for cancellation", async () => {
    const signalSeen: boolean[] = [];
    const controller = new AbortController();
    controller.abort();
    const harness = makeStartLayer({ signalSeen });

    await Effect.runPromise(startApp({ signal: controller.signal }).pipe(Effect.provide(harness.layer)));

    expect(signalSeen).toEqual([true]);
  });

  test("fails outside an app directory with init remediation", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["start"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No .lando.yml or .lando.ts found");
      expect(result.stderr).toContain("lando init");
    });
  });

  test("reports malformed Landofile file path and line", async () => {
    await withTempCwd(async (dir) => {
      await Bun.write(join(dir, ".lando.yml"), "name: bad\nservices:\n\tweb: app\n");

      const result = await runCli(["start"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Landofiles");
      expect(result.stderr).toContain("filePath:");
      expect(result.stderr).toContain(".lando.yml");
      expect(result.stderr).toContain("line: 3");
    });
  });

  test.skipIf(!process.env.LANDO_TEST_PODMAN_SOCKET)(
    "scaffolds an app and starts it against the live Podman socket",
    async () => {
      await withTempCwd(async (dir) => {
        const init = await runCli(["init", "--full", "--name=test-start"], dir);
        expect(init.exitCode).toBe(0);

        const result = await runCli(["start"], join(dir, "test-start"));

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("ready: test-start");
        expect(result.stdout).toContain("web");
        expect(result.stdout).toContain("database");
      });
    },
    60_000,
  );
});
