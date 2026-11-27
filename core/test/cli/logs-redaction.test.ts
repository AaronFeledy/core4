import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followLogsApp } from "@lando/core/cli/operations";
import { ProviderUnavailableError } from "@lando/core/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LogSource,
  LogSourceId,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/core/schema";
import { AppPlanner, LandofileService, RuntimeProviderRegistry } from "@lando/core/services";
import { LogsAppResult } from "@lando/engine/operations/logs";
import { outputRegisteredTestProvider } from "@lando/engine/testing/output-provider";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { StreamFrame } from "@lando/sdk/schema";
import type { LogChunk, LogTarget, RuntimeProviderShape } from "@lando/sdk/services";
import { makeTestRuntimeProviderRegistry } from "@lando/sdk/test";
import { DateTime, Effect, Layer, Redacted, Schema, Stream } from "effect";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";

const SECRET_VALUE = "supersecret-log-canary-9f3a";

const providerId = ProviderId.make("lando");

const capabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceInit: true,
  serviceLogs: true,
  serviceLogSources: true,
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
  projectUserMapping: "unsupported" as const,
  bindOwnership: "unknown" as const,
  privilegedServices: false,
  architectureEmulation: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-05-15T00:00:00Z"),
  source: "logs-redaction.test",
  runtime: 4 as const,
};

const database: ServicePlan = {
  name: ServiceName.make("database"),
  type: "postgres",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "postgres:16-alpine" },
  command: ["postgres"],
  environment: {},
  mounts: [],
  endpoints: [{ kind: "internal", port: 5432, protocol: "tcp", name: "database" }],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  logSources: [
    Schema.decodeUnknownSync(LogSource)({
      id: "slow-query",
      path: "/var/log/mysql/slow.log",
      stream: "stderr",
      strategy: "follow",
    }),
  ],
  metadata,
  extensions: {},
};

const plan: AppPlan = {
  id: AppId.make("test-logs-redaction"),
  name: "test-logs-redaction",
  slug: "test-logs-redaction",
  root: AbsolutePath.make("/tmp/test-logs-redaction"),
  provider: providerId,
  services: { [database.name]: database },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const makeLayer = (
  rawLines: string | readonly string[],
  providerValues: readonly string[] = [SECRET_VALUE],
) => {
  const lines = typeof rawLines === "string" ? [rawLines] : rawLines;
  const provider: RuntimeProviderShape = {
    id: "lando",
    displayName: "Lando Runtime Provider",
    version: "0.0.0",
    platform: "linux",
    capabilities,
    isAvailable: Effect.succeed(true),
    planSetup: () => Effect.succeed({ providerId, changes: [] }),
    setup: () => Effect.void,
    getStatus: Effect.succeed({ state: "running" as const }),
    getVersions: Effect.succeed({ provider: "0.0.0" }),
    buildArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "buildArtifact",
          message: "x",
          remediation: "Install or start the `lando` provider and confirm it can perform `buildArtifact`.",
        }),
      ),
    pullArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId: "lando",
          operation: "pullArtifact",
          message: "x",
          remediation: "Install or start the `lando` provider and confirm it can perform `pullArtifact`.",
        }),
      ),
    removeArtifact: () => Effect.succeed({ kind: "absent" as const }),
    listArtifacts: () => Effect.succeed([]),
    apply: () => Effect.succeed({ changed: false }),
    restart: () => Effect.void,
    waitForExit: () => Effect.succeed({ exitCode: 0 }),
    bringDown: () =>
      Effect.succeed({ kind: "removed" as const, containers: [], volumesRemoved: { data: 0, cache: 0 } }),
    bringDownObserved: (observed) => Effect.succeed({ service: observed.service, action: "absent" as const }),
    readAppEnvironment: () => Effect.succeed(providerValues.map((value) => Redacted.make(value))),
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    execStream: () => Stream.die("not used"),
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    runStream: () => Stream.die("not used"),
    logs: (target: LogTarget): Stream.Stream<LogChunk, never> =>
      Stream.fromIterable(
        lines.map((line) => ({
          service: target.service,
          source: LogSourceId.make("slow-query"),
          stream: "stderr" as const,
          line,
        })),
      ),
    inspect: () =>
      Effect.succeed({
        app: plan.id,
        service: ServiceName.make("database"),
        providerId,
        status: "running",
        publications: { status: "present", bindings: [] },
      }),
    list: () => Effect.succeed([]),
    snapshotVolume: () => Effect.die("not used"),
    removeVolumeSnapshot: () => Effect.die("not used"),
    restoreVolume: () => Effect.die("not used"),
    locateVolume: () => Effect.die("not used"),
    listVolumes: () => Effect.succeed([]),
    removeVolume: () => Effect.void,
    copyToService: () => Effect.die("not used"),
    copyFromService: () => Stream.die("not used"),
    exportVolume: () => Stream.empty,
    importVolume: () => Effect.void,
    exportArtifact: () => Stream.die("not used"),
    importArtifact: () => Effect.die("not used"),
  };

  return Layer.mergeAll(
    Layer.succeed(
      LandofileService,
      LandofileService.of({
        discover: Effect.succeed(literalLandofile({ name: "test-logs-redaction", services: {} }, plan.root)),
      }),
    ),
    Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(currentTestPlan(plan)) })),
    Layer.succeed(
      RuntimeProviderRegistry,
      makeTestRuntimeProviderRegistry({
        list: Effect.succeed([providerId]),
        capabilities: Effect.succeed(capabilities),
        select: () => Effect.succeed(outputRegisteredTestProvider(provider, plan)),
      }),
    ),
  );
};

describe("lando logs redaction boundary", () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.LANDO_SECRET_LOG_PASSWORD;
    process.env.LANDO_SECRET_LOG_PASSWORD = SECRET_VALUE;
  });

  afterEach(() => {
    if (previous === undefined) {
      delete process.env.LANDO_SECRET_LOG_PASSWORD;
    } else {
      process.env.LANDO_SECRET_LOG_PASSWORD = previous;
    }
  });

  test("masks a registered secret in a followed line for text and JSON while the on-disk file stays raw", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-logs-redaction-"));
    const logFile = join(dir, "slow-query.log");
    const rawLine = `query failed with password=${SECRET_VALUE}`;
    await writeFile(logFile, `${rawLine}\n`);

    try {
      const textIo = createBufferedRendererIO({ isTTY: false });
      await runWithRendererHandling(
        followLogsApp({ follow: true, service: "database", source: "slow-query" }),
        {
          runtime: makeLayer(rawLine),
          rendererMode: "plain",
          resultFormat: "text",
          command: "app:logs",
          resultSchema: LogsAppResult,
          streaming: StreamFrame,
          streamingMode: "live",
          io: textIo,
          formatError: ({ error }) => String(error),
        },
      );

      const textOut = textIo.stdout();
      expect(textOut).toBe("");
      expect(textIo.stderr()).toBe("database stderr [slow-query]: query failed with password=[redacted]\n");
      expect(textOut + textIo.stderr()).not.toContain(SECRET_VALUE);

      const jsonIo = createBufferedRendererIO({ isTTY: false });
      await runWithRendererHandling(
        followLogsApp({ follow: true, service: "database", source: "slow-query" }),
        {
          runtime: makeLayer(rawLine),
          rendererMode: "json",
          resultFormat: "json",
          command: "app:logs",
          resultSchema: LogsAppResult,
          streaming: StreamFrame,
          streamingMode: "live",
          io: jsonIo,
          formatError: ({ error }) => String(error),
        },
      );

      const jsonOut = jsonIo.stdout();
      expect(jsonOut + jsonIo.stderr()).not.toContain(SECRET_VALUE);
      expect(jsonIo.stderr()).toBe("");
      expect(
        jsonOut
          .trim()
          .split("\n")
          .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line))),
      ).toContainEqual({
        _tag: "stderr",
        chunk: "query failed with password=[redacted]\n",
        service: "database",
        source: "slow-query",
      });

      const onDisk = await readFile(logFile, "utf8");
      expect(onDisk).toContain(SECRET_VALUE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("fresh-process logs mask a provider value with no secret-store environment", async () => {
    Reflect.deleteProperty(process.env, "LANDO_SECRET_LOG_PASSWORD");
    const io = createBufferedRendererIO({ isTTY: false });
    await runWithRendererHandling(
      followLogsApp({ follow: true, service: "database", source: "slow-query" }),
      {
        runtime: makeLayer(`value ${SECRET_VALUE}`),
        io,
        rendererMode: "plain",
        resultFormat: "text",
        command: "app:logs",
        resultSchema: LogsAppResult,
        streaming: StreamFrame,
        streamingMode: "live",
        formatError: ({ error }) => String(error),
      },
    );
    expect(io.stdout()).toBe("");
    expect(io.stderr()).toBe("database stderr [slow-query]: value [redacted]\n");
    expect(io.stdout() + io.stderr()).not.toContain(SECRET_VALUE);
  });

  test("masks a quoted value that spans followed records for text and JSON", async () => {
    const textIo = createBufferedRendererIO({ isTTY: false });
    await runWithRendererHandling(
      followLogsApp({ follow: true, service: "database", source: "slow-query" }),
      {
        runtime: makeLayer(['password="first', 'second"']),
        rendererMode: "plain",
        resultFormat: "text",
        command: "app:logs",
        resultSchema: LogsAppResult,
        streaming: StreamFrame,
        streamingMode: "live",
        io: textIo,
        formatError: ({ error }) => String(error),
      },
    );
    expect(textIo.stdout()).toBe("");
    expect(textIo.stderr()).toBe("database stderr [slow-query]: password=[redacted]\n");

    const jsonIo = createBufferedRendererIO({ isTTY: false });
    await runWithRendererHandling(
      followLogsApp({ follow: true, service: "database", source: "slow-query" }),
      {
        runtime: makeLayer(['password="first', 'second"']),
        rendererMode: "json",
        resultFormat: "json",
        command: "app:logs",
        resultSchema: LogsAppResult,
        streaming: StreamFrame,
        streamingMode: "live",
        io: jsonIo,
        formatError: ({ error }) => String(error),
      },
    );
    expect(
      jsonIo
        .stdout()
        .trim()
        .split("\n")
        .map((line) => Schema.decodeUnknownSync(StreamFrame)(JSON.parse(line))),
    ).toContainEqual({
      _tag: "stderr",
      chunk: "password=[redacted]\n",
      service: "database",
      source: "slow-query",
    });
  });

  test("masks a registered multi-line value across followed records", async () => {
    const io = createBufferedRendererIO({ isTTY: false });
    await runWithRendererHandling(
      followLogsApp({ follow: true, service: "database", source: "slow-query" }),
      {
        runtime: makeLayer(["before left", "right after"], ["left\nright"]),
        rendererMode: "plain",
        resultFormat: "text",
        command: "app:logs",
        resultSchema: LogsAppResult,
        streaming: StreamFrame,
        streamingMode: "live",
        io,
        formatError: ({ error }) => String(error),
      },
    );
    expect(io.stderr()).toBe("database stderr [slow-query]: before [redacted] after\n");
  });
});

import { currentTestPlan, literalLandofile } from "../_support/value-contracts.ts";
