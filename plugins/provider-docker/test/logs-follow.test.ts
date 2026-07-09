import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Schema, Stream } from "effect";

import { type DockerApiClient, type DockerHttpRequest, makeProviderLayer } from "@lando/provider-docker";
import { makeMemoryLogFileAccess } from "@lando/sdk/log-follow";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  LogSource,
  type LogSource as LogSourceType,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { type LogChunk, RuntimeProvider } from "@lando/sdk/services";

const providerId = ProviderId.make("docker");
const appId = AppId.make("dockerlogfollowapp");
const appRoot = AbsolutePath.make("/tmp/lando-docker-log-follow-app");
const textEncoder = new TextEncoder();
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-14T00:00:00Z"),
  source: "logs-follow.test",
  runtime: 4 as const,
};

const node: ServicePlan = {
  name: ServiceName.make("node"),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "-e", "console.log('ready')"],
  environment: {},
  appMount: {
    source: appRoot,
    target: PortablePath.make("/app"),
    readOnly: false,
    excludes: [],
    includes: [],
    realization: "passthrough",
  },
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const source = (
  overrides: Partial<{
    readonly id: string;
    readonly path: string;
    readonly strategy: "follow" | "redirect";
    readonly stream: "stdout" | "stderr";
  }> = {},
): LogSourceType =>
  Schema.decodeUnknownSync(LogSource)({
    id: overrides.id ?? "app-log",
    path: overrides.path ?? "/var/log/app.log",
    stream: overrides.stream ?? "stderr",
    strategy: overrides.strategy ?? "follow",
  });

const makePlan = (logSources?: ReadonlyArray<LogSourceType>): AppPlan => {
  const service: ServicePlan = {
    ...node,
    ...(logSources === undefined ? {} : { logSources }),
  };
  return {
    id: appId,
    name: "Docker Log Follow App",
    slug: "dockerlogfollowapp",
    root: appRoot,
    provider: providerId,
    services: { [service.name]: service },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const makeFakeApi = (...chunks: ReadonlyArray<Uint8Array>) => {
  const calls: DockerHttpRequest[] = [];
  const api: DockerApiClient = {
    info: Effect.succeed({}),
    stream: (request) => {
      calls.push(request);
      return Stream.fromIterable(chunks);
    },
  };

  return { api, calls };
};

const rawConsole = (line: string): Uint8Array => textEncoder.encode(`2026-05-14T00:00:00Z ${line}\n`);

const collect = (stream: Stream.Stream<LogChunk, unknown>): Promise<ReadonlyArray<LogChunk>> =>
  Effect.runPromise(Stream.runCollect(stream).pipe(Effect.map((chunks) => [...chunks])));

describe("provider-docker log followers", () => {
  test("merges finite console and file-follow logs when follow is false", async () => {
    const fileSource = source();
    const plan = makePlan([fileSource]);
    const fs = makeMemoryLogFileAccess();
    fs.writeFile(fileSource.path, "file ready\n");
    const fake = makeFakeApi(rawConsole("console ready"));
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({ platform: "linux", env: {}, dockerApi: fake.api, logFileAccess: fs.access }),
        ),
      ),
    );

    const chunks = await collect(
      provider.logs({ app: appId, service: node.name, plan }, { follow: false, sources: [fileSource] }),
    );

    const consoleChunk = chunks.find((chunk) => chunk.line === "console ready");
    const fileChunk = chunks.find((chunk) => chunk.line === "file ready");
    expect(consoleChunk?.source).toBeUndefined();
    expect(fileChunk?.source).toBe(fileSource.id);
    expect(fileChunk?.stream).toBe("stderr");
  });

  test("streams only console logs when a service has no follow sources", async () => {
    const redirectSource = source({
      id: "redirected",
      path: "/var/log/redirected.log",
      strategy: "redirect",
    });
    const plan = makePlan([redirectSource]);
    const fs = makeMemoryLogFileAccess();
    fs.writeFile(redirectSource.path, "redirected file\n");
    const fake = makeFakeApi(rawConsole("console only"));
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({ platform: "linux", env: {}, dockerApi: fake.api, logFileAccess: fs.access }),
        ),
      ),
    );

    const chunks = await collect(
      provider.logs({ app: appId, service: node.name, plan }, { follow: false, sources: [redirectSource] }),
    );

    expect(chunks.map((chunk) => chunk.line)).toEqual(["console only"]);
    expect(chunks[0]?.source).toBeUndefined();
  });
});
