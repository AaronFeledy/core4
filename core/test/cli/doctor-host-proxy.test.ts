import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, Effect, Layer } from "effect";

import { ConfigService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { AbsolutePath, type GlobalConfig, ProviderId } from "@lando/sdk/schema";

import { doctor, renderDoctorResult, renderDoctorResultAsNdjson } from "../../src/cli/commands/doctor.ts";
import {
  HOST_PROXY_WORKER_PROTOCOL_VERSION,
  writeWorkerRecord,
} from "../../src/subsystems/host-proxy/worker-state.ts";

const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          if (!server.listening) return resolve();
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const tempRoot = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), "lando-doctor-host-proxy-"));
  roots.push(root);
  return root;
};

const buildRegistry = (provider: typeof TestRuntimeProvider) => ({
  list: Effect.succeed([ProviderId.make(provider.id)]),
  capabilities: Effect.succeed(provider.capabilities),
  select: () => Effect.succeed(provider),
});

const buildConfigService = (userDataRoot: string): Context.Tag.Service<typeof ConfigService> => {
  const config: GlobalConfig = {
    defaultProviderId: ProviderId.make("lando"),
    telemetry: { enabled: false },
    userDataRoot: AbsolutePath.make(userDataRoot),
  };
  const load = Effect.succeed(config);
  return {
    load,
    get: (key) => Effect.map(load, (loadedConfig) => loadedConfig[key]),
  };
};

const runDoctor = (userDataRoot: string, provider: typeof TestRuntimeProvider = TestRuntimeProvider) =>
  Effect.runPromise(
    doctor().pipe(
      Effect.provide(
        Layer.merge(
          Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)),
          Layer.succeed(ConfigService, buildConfigService(userDataRoot)),
        ),
      ),
    ),
  );

const listenUnix = (server: Server, socketPath: string): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve();
    });
    server.listen(socketPath);
  });

const listenTcp = (server: Server): Promise<void> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.once("listening", () => {
      server.off("error", reject);
      resolve();
    });
    server.listen(0, "127.0.0.1");
  });

describe("meta:doctor host-proxy transport reachability", () => {
  test("reports a live Unix-socket worker as reachable", async () => {
    // Given
    const root = await tempRoot();
    const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make(join(root, "app")) };
    const socketPath = join(root, "host-proxy-control.sock");
    const controlToken = "doctor-control-token";
    const server = createServer((request, response) => {
      if (request.headers["x-lando-host-proxy-control"] !== controlToken) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          appId: app.id,
          sessionId: "doctor-session",
          transport: "unix-socket",
          protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
          pid: process.pid,
        }),
      );
    });
    servers.push(server);
    await listenUnix(server, socketPath);
    await Effect.runPromise(
      writeWorkerRecord(
        app,
        { userDataRoot: root },
        {
          appId: app.id,
          appRoot: app.root,
          transport: "unix-socket",
          socketPath,
          shimPath: join(root, "lando"),
          protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
          startedAt: "2026-07-15T00:00:00.000Z",
          pid: process.pid,
          controlToken,
        },
      ),
    );

    // When
    const result = await runDoctor(root);

    // Then
    const check = result.checks.find((candidate) => candidate.name === "host-proxy-transport");
    expect(check).toMatchObject({
      status: "pass",
      severity: "info",
      context: {
        appId: "demo",
        transport: "unix-socket",
        reachability: "reachable",
        endpoint: socketPath,
      },
      solutions: [],
    });
  });

  test("stays silent when no host-proxy worker is expected", async () => {
    // Given
    const root = await tempRoot();

    // When
    const result = await runDoctor(root);

    // Then
    expect(result.checks.some((check) => check.name === "host-proxy-transport")).toBe(false);
  });

  test("reports an unreachable Windows gateway bridge with structured remediation", async () => {
    // Given
    const root = await tempRoot();
    const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make(join(root, "app")) };
    const closedPortServer = createServer();
    await listenTcp(closedPortServer);
    const address = closedPortServer.address() as AddressInfo;
    await new Promise<void>((resolve) => closedPortServer.close(() => resolve()));
    const endpoint = `http://127.0.0.1:${address.port}`;
    const controlToken = "unreachable-control-token";
    await Effect.runPromise(
      writeWorkerRecord(
        app,
        { userDataRoot: root },
        {
          appId: app.id,
          appRoot: app.root,
          transport: "tcp-host-gateway",
          url: endpoint,
          shimPath: join(root, "lando.exe"),
          protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
          startedAt: "2026-07-15T00:00:00.000Z",
          pid: process.pid,
          controlToken,
        },
      ),
    );
    const provider = {
      ...TestRuntimeProvider,
      platform: "win32" as const,
      capabilities: {
        ...TestRuntimeProvider.capabilities,
        hostProxy: {
          containerTargets: [{ os: "linux" as const, arch: "x64" as const }],
          tcpHostGateway: "host.containers.internal",
        },
      },
    };

    // When
    const result = await runDoctor(root, provider);

    // Then
    const check = result.checks.find((candidate) => candidate.name === "host-proxy-transport");
    expect(check).toMatchObject({
      status: "warn",
      severity: "warn",
      context: {
        appId: "demo",
        transport: "tcp-host-gateway",
        reachability: "unreachable",
        endpoint,
        containerGateway: "host.containers.internal",
      },
      solutions: [
        {
          kind: "manual",
          command: "lando restart",
        },
      ],
    });

    const text = renderDoctorResult(result);
    const ndjson = renderDoctorResultAsNdjson(result, {
      now: new Date("1970-01-01T00:00:00.000Z"),
    });
    expect(text).toContain("host-proxy-transport: warn");
    expect(text).toContain("containerGateway: host.containers.internal");
    expect(ndjson).toContain('"event":"doctor.check"');
    expect(ndjson).toContain('"containerGateway":"host.containers.internal"');
    expect(text).not.toContain(controlToken);
    expect(ndjson).not.toContain(controlToken);
  });
});
