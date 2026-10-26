import { describe, expect, test } from "bun:test";

import { Cause, DateTime, Effect, Exit, Option, Stream } from "effect";

import {
  type DockerApiClient,
  type DockerHttpRequest,
  layer as makeProviderLayer,
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
  resolvedAt: DateTime.makeUnsafe("2026-08-21T00:00:00Z"),
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
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
});

const rawConsole = (line: string): Uint8Array => textEncoder.encode(`2026-05-17T12:00:00.000Z ${line}\n`);

const consoleFrame = (stream: 1 | 2, text: string): Uint8Array => {
  const payload = textEncoder.encode(text);
  const frame = new Uint8Array(8 + payload.length);
  frame[0] = stream;
  new DataView(frame.buffer).setUint32(4, payload.length);
  frame.set(payload, 8);
  return frame;
};

const collectLogs = (stream: Stream.Stream<LogChunk, unknown>): Promise<ReadonlyArray<LogChunk>> =>
  Effect.runPromise(Stream.runCollect(stream).pipe(Effect.map((chunks) => [...chunks])));

const makeFakeApi = (
  options: {
    readonly containers?: ReadonlyArray<{
      readonly name: string;
      readonly labels: Readonly<Record<string, string>>;
    }>;
    readonly logLine?: string;
    readonly logFrames?: ReadonlyArray<Uint8Array>;
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
        return Stream.fromIterable(options.logFrames ?? [rawConsole(logLine)]);
      }
      return Stream.empty;
    },
  };
  return { api, calls };
};

describe("provider-docker logs", () => {
  test.each([true, false])("reassembles multiplexed lines and flushes EOF with plan=%s", async (withPlan) => {
    const fake = makeFakeApi({
      containers: [
        { name: "lando-myapp-web", labels: { "dev.lando.app": appId, "dev.lando.service": serviceName } },
      ],
      logFrames: [
        consoleFrame(1, "2026-05-17T12:00:00.000Z is"),
        consoleFrame(2, "2026-05-17T12:00:01.000Z err-"),
        consoleFrame(1, "2026-05-17T12:00:02.000Z  ready\n    indented\ntail"),
        consoleFrame(2, "2026-05-17T12:00:03.000Z part\n"),
      ],
    });
    const provider = await Effect.runPromise(makeRuntimeProvider({ platform: "linux", dockerApi: fake.api }));
    const logs = await collectLogs(
      provider.logs(
        { app: appId, service: serviceName, ...(withPlan ? { plan: makePlan() } : {}) },
        { follow: false },
      ),
    );
    expect(
      logs.map(({ service, stream, line, timestamp }) => [service, stream, line, timestamp?.toISOString()]),
    ).toEqual([
      [serviceName, "stdout", "is ready", "2026-05-17T12:00:00.000Z"],
      [serviceName, "stdout", "    indented", "2026-05-17T12:00:02.000Z"],
      [serviceName, "stderr", "err-part", "2026-05-17T12:00:01.000Z"],
      [serviceName, "stdout", "tail", "2026-05-17T12:00:02.000Z"],
    ]);
  });

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
        timestamp: DateTime.toDate(DateTime.makeUnsafe("2026-05-17T12:00:00.000Z")),
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
    if (Exit.isFailure(exit)) {
      const error = Option.getOrUndefined(Cause.findErrorOption(exit.cause));
      expect(error).toBeInstanceOf(ProviderUnavailableError);
      expect(error?.message).not.toContain("does not implement");
      expect(error?.message).toContain("Container for app");
    }
  });
});
