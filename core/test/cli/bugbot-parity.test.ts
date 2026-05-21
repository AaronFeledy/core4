import { describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";

import { DateTime, Effect, Layer } from "effect";

import { renderStopAppResult, stopApp } from "@lando/core/cli/operations";
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

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCli = async (args: ReadonlyArray<string>): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

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
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "bugbot-parity.test",
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
  id: AppId.make("test-signal"),
  name: "test-signal",
  slug: "test-signal",
  root: AbsolutePath.make("/tmp/test-signal"),
  provider: providerId,
  services: { [web.name]: web },
  routes: [],
  networks: [],
  stores: [],
  metadata,
  extensions: {},
};

const makeSignalLayer = () => {
  const destroyCalls: Array<{ readonly target: AppSelector; readonly options: DestroyOptions }> = [];
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
    apply: () => Effect.succeed({ changed: false }),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    destroy: (target, options) =>
      Effect.sync(() => {
        destroyCalls.push({ target, options });
      }),
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    execStream: () => Effect.die("not used") as never,
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    logs: () => Effect.die("not used") as never,
    inspect: (target) =>
      Effect.succeed({
        app: plan.id,
        service: target.service,
        providerId,
        status: "running",
        state: "running",
        endpoints: [],
      }),
    list: () => Effect.succeed([]),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(LandofileService, { discover: Effect.succeed({ name: "test-signal", services: {} }) }),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(capabilities),
      select: () => Effect.succeed(provider),
    }),
    Layer.succeed(EventService, {
      publish: () => Effect.void,
      subscribe: () => Effect.die("not used"),
      subscribeQueue: Effect.die("not used"),
      waitFor: () => Effect.die("not used"),
    }),
  );

  return { layer, destroyCalls };
};

describe("PR #57: stopApp forwards AbortSignal to provider.destroy", () => {
  test("signal is present in DestroyOptions when supplied", async () => {
    const harness = makeSignalLayer();
    const controller = new AbortController();
    await Effect.runPromise(stopApp({ signal: controller.signal }).pipe(Effect.provide(harness.layer)));

    expect(harness.destroyCalls).toHaveLength(1);
    expect(harness.destroyCalls[0]?.options.signal).toBe(controller.signal);
  });

  test("signal is absent from DestroyOptions when not supplied", async () => {
    const harness = makeSignalLayer();
    await Effect.runPromise(stopApp().pipe(Effect.provide(harness.layer)));

    expect(harness.destroyCalls).toHaveLength(1);
    expect(harness.destroyCalls[0]?.options.signal).toBeUndefined();
  });

  test("pre-aborted signal is forwarded and destroy still completes", async () => {
    const harness = makeSignalLayer();
    const controller = new AbortController();
    controller.abort();
    await Effect.runPromise(stopApp({ signal: controller.signal }).pipe(Effect.provide(harness.layer)));

    expect(harness.destroyCalls).toHaveLength(1);
    expect(harness.destroyCalls[0]?.options.signal?.aborted).toBe(true);
    expect(renderStopAppResult({ app: "test-signal", servicesStopped: ["web"] })).toBe(
      "stopped: test-signal - web",
    );
  });
});

describe("PR #61: meta:version and meta:shellenv produce output, not NotImplementedError", () => {
  test("lando meta:version exits 0 and prints a version string", async () => {
    const result = await runCli(["meta:version"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("NotImplementedError");
    expect(result.stderr).not.toContain("not implemented");
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  test("lando meta:shellenv exits 0 and prints LANDO_INSTALL_DIR export", async () => {
    const result = await runCli(["meta:shellenv"]);
    expect(result.exitCode).toBe(0);
    expect(result.stderr).not.toContain("NotImplementedError");
    expect(result.stderr).not.toContain("not implemented");
    expect(result.stdout).toContain("LANDO_INSTALL_DIR");
    expect(result.stdout).toContain("export PATH");
  });
});

describe("PR #101: listServices path option filters by appRoot substring", () => {
  test("path option filters apps to those whose appRoot includes the substring", async () => {
    const { mkdir, mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { ConfigService } = await import("@lando/sdk/services");

    const userDataRoot = await mkdtemp(join(tmpdir(), "lando-parity-path-"));
    const isolatedCacheRoot = await mkdtemp(join(tmpdir(), "lando-parity-cache-"));
    try {
      const appsDir = join(userDataRoot, "providers", "provider-lando", "apps");
      await mkdir(appsDir, { recursive: true });
      const makePlan = (id: string, root: string) => ({
        version: 1,
        providerId: "lando",
        appId: id,
        plan: { id, name: id, root, provider: "lando", services: {} },
      });
      await writeFile(join(appsDir, "app-alpha.json"), JSON.stringify(makePlan("app-alpha", "/srv/alpha")));
      await writeFile(join(appsDir, "app-bravo.json"), JSON.stringify(makePlan("app-bravo", "/srv/bravo")));

      const fakeConfig = Layer.succeed(ConfigService, {
        get: <K extends string>(key: K) =>
          Effect.succeed(key === "userDataRoot" ? (userDataRoot as never) : (undefined as never)),
        getEffective: () => Effect.succeed({} as never),
      } as never);

      const { listServices } = await import("../../src/cli/commands/list.ts");

      const allApps = await Effect.runPromise(
        listServices({ userDataRoot, userCacheRoot: isolatedCacheRoot }).pipe(Effect.provide(fakeConfig)),
      );
      expect(allApps.apps.map((a) => a.appName).sort()).toEqual(["app-alpha", "app-bravo"]);

      const filtered = await Effect.runPromise(
        listServices({ userDataRoot, userCacheRoot: isolatedCacheRoot, path: "/srv/alpha" }).pipe(
          Effect.provide(fakeConfig),
        ),
      );
      expect(filtered.apps.map((a) => a.appName)).toEqual(["app-alpha"]);
      expect(filtered.apps.find((a) => a.appName === "app-bravo")).toBeUndefined();
    } finally {
      await rm(userDataRoot, { recursive: true, force: true });
      await rm(isolatedCacheRoot, { recursive: true, force: true });
    }
  });
});

describe("PR #103: InitAppOptions.full is optional; --full removed from CLI", () => {
  test("lando init --no-interactive exits 1 with missing-answer error without needing --full", async () => {
    const result = await runCli(["init", "--no-interactive"]);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Missing required answer for prompt "name"');
  });
});
