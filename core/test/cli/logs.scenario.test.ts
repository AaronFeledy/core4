import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cause, DateTime, Effect, Exit, Layer, Stream } from "effect";

import { logsApp, renderLogsAppResult } from "@lando/core/cli/operations";
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
import type { LogChunk, LogOptions, LogTarget, RuntimeProviderShape } from "@lando/sdk/services";

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
  volumeSnapshot: "none",
  serviceFileCopy: "none",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
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
  source: "logs.scenario.test",
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
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const web = servicePlan("web");
const database = servicePlan("database");
const plan: AppPlan = {
  id: AppId.make("test-logs"),
  name: "test-logs",
  slug: "test-logs",
  root: AbsolutePath.make("/tmp/test-logs"),
  provider: providerId,
  services: { [web.name]: web, [database.name]: database },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-logs-scenario-")));
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

const makeLogsLayer = () => {
  const logCalls: Array<{ readonly target: LogTarget; readonly options: LogOptions }> = [];
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
    destroy: () => Effect.void,
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    execStream: () => Stream.die("not used"),
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    logs: (target, options) => {
      logCalls.push({ target, options });
      const chunks: LogChunk[] = [
        { service: target.service, stream: "stdout", line: `${String(target.service)} line 1` },
        { service: target.service, stream: "stderr", line: `${String(target.service)} warn` },
      ];
      return Stream.fromIterable(chunks);
    },
    inspect: () =>
      Effect.succeed({
        app: plan.id,
        service: ServiceName.make("web"),
        providerId,
        status: "running",
        state: "running",
        endpoints: [],
      }),
    list: () => Effect.succeed([]),
  };

  const layer = Layer.mergeAll(
    Layer.succeed(LandofileService, { discover: Effect.succeed({ name: "test-logs", services: {} }) }),
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
      waitForAny: () => Effect.die("not used"),
      query: () => Effect.succeed([]),
    }),
  );

  return { layer, logCalls };
};

describe("lando logs", () => {
  test("collects log lines from every planned service via the provider", async () => {
    const harness = makeLogsLayer();
    const result = await Effect.runPromise(logsApp().pipe(Effect.provide(harness.layer)));

    expect(harness.logCalls.map((call) => String(call.target.service))).toEqual(["web", "database"]);
    expect(harness.logCalls.every((call) => call.options.follow === false)).toBe(true);
    expect(result.lines.map((line) => `${line.service}/${line.stream}/${line.line}`)).toEqual([
      "web/stdout/web line 1",
      "web/stderr/web warn",
      "database/stdout/database line 1",
      "database/stderr/database warn",
    ]);
    const rendered = renderLogsAppResult(result);
    expect(rendered).toContain("web stdout: web line 1");
    expect(rendered).toContain("database stderr: database warn");
  });

  test("filters by --service when set", async () => {
    const harness = makeLogsLayer();
    const result = await Effect.runPromise(
      logsApp({ service: "database" }).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.logCalls.map((call) => String(call.target.service))).toEqual(["database"]);
    expect(result.lines.every((line) => line.service === "database")).toBe(true);
  });

  test("forwards --follow / --tail options to the provider", async () => {
    const harness = makeLogsLayer();
    await Effect.runPromise(logsApp({ follow: true, tail: 25 }).pipe(Effect.provide(harness.layer)));

    expect(harness.logCalls[0]?.options).toEqual({ follow: true, tail: 25 });
  });

  test("fails outside an app directory with init remediation", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["logs"], dir);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("No .lando.yml or .lando.ts found");
      expect(result.stderr).toContain("lando init");
    });
  });

  test("fails with available service list when --service does not match the plan", async () => {
    const harness = makeLogsLayer();
    const exit = await Effect.runPromiseExit(
      logsApp({ service: "nope" }).pipe(Effect.provide(harness.layer)),
    );

    expect(harness.logCalls).toEqual([]);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      expect(failure._tag).toBe("Some");
      if (failure._tag === "Some") {
        const error = failure.value as { _tag: string; message: string };
        expect(error._tag).toBe("ToolingExecError");
        expect(error.message).toContain("nope");
        expect(error.message).toContain("available: database, web");
      }
    }
  });

  test("source CLI rejects --follow with structured NotImplementedError", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: test-logs-follow\nservices: {}\n");
      const result = await runCli(["logs", "--follow"], dir);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("NotImplementedError");
      expect(result.stderr).toContain("--follow");
      expect(result.stderr).toContain("deferred");
    });
  });

  test("source CLI rejects --since with structured NotImplementedError", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: test-logs-since\nservices: {}\n");
      const result = await runCli(["logs", "--since", "1h"], dir);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("NotImplementedError");
      expect(result.stderr).toContain("--since");
    });
  });
});
