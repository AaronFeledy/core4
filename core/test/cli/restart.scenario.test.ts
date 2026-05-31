import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DateTime, Effect, Layer, Stream } from "effect";

import { renderRestartAppResult, restartApp } from "@lando/core/cli/operations";
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
import type { AppSelector, DestroyOptions, RuntimeProviderShape } from "@lando/sdk/services";

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
  copyOnWriteAppRoot: false,
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
  source: "restart.scenario.test",
  runtime: 4 as const,
};

const servicePlan = (name: "web"): ServicePlan => ({
  name: ServiceName.make(name),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "server.js"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [{ port: 3000, protocol: "http", name: "http" }],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const web = servicePlan("web");
const plan: AppPlan = {
  id: AppId.make("test-restart"),
  name: "test-restart",
  slug: "test-restart",
  root: AbsolutePath.make("/tmp/test-restart"),
  provider: providerId,
  services: { [web.name]: web },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-restart-scenario-")));
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

const makeRestartLayer = () => {
  const events: string[] = [];
  const destroyCalls: Array<{ readonly target: AppSelector; readonly options: DestroyOptions }> = [];
  const applyCalls: Array<{ readonly reconcile: boolean }> = [];
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
    apply: (_plan, options) =>
      Effect.sync(() => {
        applyCalls.push({ reconcile: options.reconcile ?? false });
      }).pipe(Effect.as({ changed: true })),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    destroy: (target, options) =>
      Effect.sync(() => {
        destroyCalls.push({ target, options });
      }),
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
    Layer.succeed(LandofileService, { discover: Effect.succeed({ name: "test-restart", services: {} }) }),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(capabilities),
      select: () => Effect.succeed(provider),
    }),
    Layer.succeed(EventService, {
      publish: (event) => Effect.sync(() => events.push(event._tag)),
      subscribe: () => Effect.die("not used"),
      subscribeQueue: Effect.die("not used"),
      waitFor: () => Effect.die("not used"),
    }),
  );

  return { layer, events, destroyCalls, applyCalls };
};

describe("lando restart", () => {
  test("destroys then applies provider-lando and publishes stop+start events", async () => {
    const harness = makeRestartLayer();
    const result = await Effect.runPromise(restartApp().pipe(Effect.provide(harness.layer)));

    expect(harness.events).toEqual([
      "pre-app-stop",
      "pre-service-stop",
      "post-service-stop",
      "post-app-stop",
      "pre-app-start",
      "task.tree.start",
      "task.start",
      "task.complete",
      "task.tree.complete",
      "post-app-start",
    ]);
    expect(harness.destroyCalls).toHaveLength(1);
    expect(harness.destroyCalls).toMatchObject([{ options: { volumes: false, removeState: false } }]);
    expect(harness.applyCalls).toEqual([{ reconcile: false }]);
    expect(result.servicesStarted.map((service) => [service.name, service.state])).toEqual([
      ["web", "running"],
    ]);
    expect(renderRestartAppResult(result)).toBe(
      "restarted: test-restart - web (running) http://localhost:3000",
    );
  });

  test("fails outside an app directory with init remediation", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["restart"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No .lando.yml or .lando.ts found");
      expect(result.stderr).toContain("lando init");
    });
  });
});
