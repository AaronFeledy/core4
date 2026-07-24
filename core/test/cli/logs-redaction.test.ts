import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect, Layer, Schema, Stream } from "effect";

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
import { StreamFrame } from "@lando/sdk/schema";
import type { LogChunk, LogTarget, RuntimeProviderShape } from "@lando/sdk/services";
import { EmptyResultSchema } from "../../src/cli/oclif/command-base.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";

const SECRET_VALUE = "supersecret-log-canary-9f3a";

const providerId = ProviderId.make("lando");

const capabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
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
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
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
  storage: [],
  endpoints: [{ _tag: "internal", port: 5432, protocol: "tcp", name: "database" }],
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
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const makeLayer = (rawLine: string) => {
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
        new ProviderUnavailableError({ providerId: "lando", operation: "buildArtifact", message: "x" }),
      ),
    pullArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({ providerId: "lando", operation: "pullArtifact", message: "x" }),
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
    runStream: () => Stream.die("not used"),
    logs: (target: LogTarget): Stream.Stream<LogChunk, never> =>
      Stream.fromIterable([
        { service: target.service, source: LogSourceId.make("slow-query"), stream: "stderr", line: rawLine },
      ]),
    inspect: () =>
      Effect.succeed({
        app: plan.id,
        service: ServiceName.make("database"),
        providerId,
        status: "running",
        state: "running",
        endpoints: [],
      }),
    list: () => Effect.succeed([]),
    snapshotVolume: () => Effect.die("not used"),
    restoreVolume: () => Effect.die("not used"),
    listVolumes: () => Effect.succeed([]),
    removeVolume: () => Effect.void,
    copyToService: () => Effect.die("not used"),
    copyFromService: () => Stream.die("not used"),
    exportArtifact: () => Stream.die("not used"),
    importArtifact: () => Effect.die("not used"),
  };

  return Layer.mergeAll(
    Layer.succeed(LandofileService, {
      discover: Effect.succeed({ name: "test-logs-redaction", services: {} }),
    }),
    Layer.succeed(AppPlanner, { plan: () => Effect.succeed(plan) }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(capabilities),
      select: () => Effect.succeed(provider),
    }),
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
      // biome-ignore lint/performance/noDelete: env cleanup must remove the key (Bun coerces undefined to "undefined")
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
          resultSchema: EmptyResultSchema,
          streaming: StreamFrame,
          streamingMode: "live",
          io: textIo,
          formatError: (error) => String(error),
        },
      );

      const textOut = textIo.stdout();
      expect(textOut).not.toContain(SECRET_VALUE);
      expect(textOut).toContain("[redacted]");

      const jsonIo = createBufferedRendererIO({ isTTY: false });
      await runWithRendererHandling(
        followLogsApp({ follow: true, service: "database", source: "slow-query" }),
        {
          runtime: makeLayer(rawLine),
          rendererMode: "json",
          resultFormat: "json",
          command: "app:logs",
          resultSchema: EmptyResultSchema,
          streaming: StreamFrame,
          streamingMode: "live",
          io: jsonIo,
          formatError: (error) => String(error),
        },
      );

      const jsonOut = jsonIo.stdout();
      expect(jsonOut).not.toContain(SECRET_VALUE);
      expect(jsonOut).toContain("[redacted]");

      const onDisk = await readFile(logFile, "utf8");
      expect(onDisk).toContain(SECRET_VALUE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
