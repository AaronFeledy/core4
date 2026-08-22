import { describe, expect, test } from "bun:test";

import { DateTime, Effect, Exit, Stream } from "effect";

import {
  type DockerApiClient,
  type DockerHttpRequest,
  makeProviderLayer,
  makeRuntimeProvider,
} from "@lando/provider-docker";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { type LogChunk, RuntimeProvider } from "@lando/sdk/services";

const appId = AppId.make("myapp");
const serviceName = ServiceName.make("web");
const providerId = ProviderId.make("docker");
const textEncoder = new TextEncoder();
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-08-21T00:00:00Z"),
  source: "docker-logs.test",
  runtime: 4 as const,
};

const makeService = (): ServicePlan => ({
  name: serviceName,
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "node:22-alpine" },
  command: ["node", "-e", "console.log('ready')"],
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

const makePlan = (): AppPlan => ({
  id: appId,
  name: "My App",
  slug: "myapp",
  root: AbsolutePath.make("/tmp/lando-docker-logs-app"),
  provider: providerId,
  services: { [serviceName]: makeService() },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

const rawConsole = (line: string): Uint8Array => textEncoder.encode(`2026-05-17T12:00:00.000Z ${line}\n`);

const collectLogs = (stream: Stream.Stream<LogChunk, unknown>): Promise<ReadonlyArray<LogChunk>> =>
  Effect.runPromise(Stream.runCollect(stream).pipe(Effect.map((chunks) => [...chunks])));

const makeFakeApi = (
  options: {
    readonly containers?: ReadonlyArray<{
      readonly name: string;
      readonly labels: Readonly<Record<string, string>>;
    }>;
    readonly logLine?: string;
  } = {},
): {
  readonly api: DockerApiClient;
  readonly calls: DockerHttpRequest[];
} => {
  const calls: DockerHttpRequest[] = [];
  const containers = options.containers ?? [];
  const logLine = options.logLine ?? "ready";
  const api: DockerApiClient = {
    info: Effect.succeed({}),
    request: (request) => {
      calls.push(request);
      if (request.path.startsWith("/containers/json?")) {
        return Effect.succeed({
          status: 200,
          body: JSON.stringify(
            containers.map((container) => ({
              Id: `${container.name}-id`,
              Names: [`/${container.name}`],
              Labels: container.labels,
              State: "running",
              Status: "Up 1 minute",
            })),
          ),
        });
      }
      return Effect.succeed({ status: 404, body: "" });
    },
    stream: (request) => {
      calls.push(request);
      if (request.path.includes("/logs?")) {
        return Stream.fromIterable([rawConsole(logLine)]);
      }
      return Stream.empty;
    },
  };
  return { api, calls };
};

describe("provider-docker logs", () => {
  test("streams Docker Engine logs when the app plan is passed in the target", async () => {
    const fake = makeFakeApi();
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ platform: "linux", dockerApi: fake.api }))),
    );
    const plan = makePlan();

    const logs = await collectLogs(
      provider.logs(
        { app: appId, service: serviceName, plan },
        { follow: false, tail: 20, since: "1778371200" },
      ),
    );

    expect(logs).toEqual([
      {
        service: serviceName,
        stream: "stdout",
        line: "ready",
        timestamp: new Date("2026-05-17T12:00:00.000Z"),
      },
    ]);
    expect(fake.calls.find((call) => call.path.includes("/logs?"))?.path).toBe(
      "/containers/lando-myapp-web/logs?stdout=true&stderr=true&follow=false&timestamps=true&tail=20&since=1778371200",
    );
    expect(fake.calls.some((call) => call.path.startsWith("/containers/json?"))).toBe(false);
    expect(provider.capabilities.serviceLogs).toBe(true);
  });

  test("discovers a labeled container when no plan is available in this process", async () => {
    const fake = makeFakeApi({
      containers: [
        {
          name: "lando-myapp-web",
          labels: { "dev.lando.app": appId, "dev.lando.service": serviceName },
        },
      ],
      logLine: "discovered",
    });
    const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: fake.api }));

    const logs = await collectLogs(
      provider.logs({ app: appId, service: serviceName }, { follow: false, tail: 20 }),
    );

    expect(logs.map((chunk) => chunk.line)).toEqual(["discovered"]);
    expect(fake.calls.some((call) => call.path.startsWith("/containers/json?"))).toBe(true);
    expect(fake.calls.find((call) => call.path.includes("/logs?"))?.path).toContain(
      "/containers/lando-myapp-web/logs?",
    );
    expect(fake.calls.find((call) => call.path.includes("/logs?"))?.path).toContain("tail=20");
  });

  test("does not report unimplemented logs when the container is missing", async () => {
    const fake = makeFakeApi();
    const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: fake.api }));

    const exit = await Effect.runPromiseExit(
      Stream.runCollect(provider.logs({ app: appId, service: serviceName }, { follow: false })),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (exit._tag === "Failure" && exit.cause._tag === "Fail") {
      expect(exit.cause.error).toBeInstanceOf(ProviderUnavailableError);
      expect(exit.cause.error.message).not.toContain("does not implement");
      expect(exit.cause.error.message).toContain("Container for app");
    }
  });
});
