import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Context, Effect, Layer } from "effect";

import { ConfigService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { AbsolutePath, type GlobalConfig, ProviderId } from "@lando/sdk/schema";

import {
  buildHostProxyAllowlistDoctorCheck,
  hostProxyAllowlistFreshness,
} from "../../src/cli/commands/doctor-host-proxy-allowlist.ts";
import { doctor, renderDoctorResult, renderDoctorResultAsNdjson } from "../../src/cli/commands/doctor.ts";
import { makeLandoPaths, sanitizeAppName } from "../../src/config/paths.ts";
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

const runDoctor = (
  userDataRoot: string,
  provider: typeof TestRuntimeProvider = TestRuntimeProvider,
  env?: Readonly<Record<string, string | undefined>>,
) =>
  Effect.runPromise(
    doctor(env === undefined ? {} : { env }).pipe(
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
  test("reports stale generated allowlist entries from literal manifest metadata", () => {
    // Given
    const commands = {
      "app:open": { landoSpec: { hostProxyAllowed: true } },
      "app:info": { landoSpec: { hostProxyAllowed: true } },
      "app:start": { landoSpec: { hostProxyAllowed: false } },
    };

    // When
    const freshness = hostProxyAllowlistFreshness(["app:open", "removed:command"], commands);

    // Then
    expect(freshness).toEqual({
      fresh: false,
      missing: ["app:info"],
      unexpected: ["removed:command"],
    });
    expect(hostProxyAllowlistFreshness(["app:open", "app:info"], commands).fresh).toBe(false);
    expect(hostProxyAllowlistFreshness(["app:info", "app:open", "app:open"], commands).fresh).toBe(false);
    expect(
      buildHostProxyAllowlistDoctorCheck(freshness, {
        provider: {
          id: TestRuntimeProvider.id,
          displayName: TestRuntimeProvider.displayName,
          version: TestRuntimeProvider.version,
        },
        providerKind: "user-installed",
        runtimeStatus: "ready",
        runtime: { running: true },
        selection: {
          providerId: TestRuntimeProvider.id,
          source: "default",
          inputs: { capabilityDefault: TestRuntimeProvider.id },
        },
      }),
    ).toMatchObject({
      name: "host-proxy-allowlist",
      status: "warn",
      context: { freshness: "stale", missing: "app:info", unexpected: "removed:command" },
      solutions: [{ command: "bun run codegen:host-proxy-allowlist" }],
    });
  });

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
    await chmod(socketPath, 0o600);
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

  test("reports a live legacy Unix-socket worker as reachable", async () => {
    // Given
    const root = await tempRoot();
    const appId = "legacy-demo";
    const runDir = join(makeLandoPaths({ userDataRoot: root }).hostProxyRunRoot, sanitizeAppName(appId));
    const socketPath = join(runDir, "host-proxy.sock");
    const controlToken = "legacy-control-token";
    const server = createServer((request, response) => {
      if (request.headers["x-lando-host-proxy-control"] !== controlToken) {
        response.writeHead(401).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          appId,
          sessionId: "legacy-session",
          transport: "unix-socket",
          protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
          pid: process.pid,
        }),
      );
    });
    servers.push(server);
    await mkdir(runDir, { recursive: true });
    await listenUnix(server, socketPath);
    await chmod(socketPath, 0o600);
    await writeFile(
      join(runDir, "worker.json"),
      `${JSON.stringify({
        appId,
        transport: "unix-socket",
        socketPath,
        shimPath: join(runDir, "lando"),
        protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
        startedAt: "2026-07-15T00:00:00.000Z",
        pid: process.pid,
        controlToken,
      })}\n`,
    );

    // When
    const result = await runDoctor(root);

    // Then
    expect(result.checks.find((candidate) => candidate.name === "host-proxy-transport")).toMatchObject({
      status: "pass",
      context: { appId, transport: "unix-socket", reachability: "reachable" },
    });
  });

  test("warns when a live Unix endpoint is not a mode-0600 socket", async () => {
    // Given
    const root = await tempRoot();
    const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make(join(root, "app")) };
    const socketPath = join(root, "host-proxy-control.sock");
    const controlToken = "doctor-control-token";
    const server = createServer((_request, response) => {
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
    await chmod(socketPath, 0o644);
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
    expect(result.checks.find((candidate) => candidate.name === "host-proxy-transport")).toMatchObject({
      status: "warn",
      context: { socketType: "socket", socketMode: "0644", reachability: "unreachable" },
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
        endpoint: "missing",
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

  test("rejects a persisted TCP alias that does not match the provider gateway", async () => {
    // Given
    const root = await tempRoot();
    const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make(join(root, "app")) };
    const containerUrl = "http://unexpected.internal:32123";
    const controlToken = "unreachable-control-token";
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
          transport: "tcp-host-gateway",
          protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
          pid: process.pid,
        }),
      );
    });
    servers.push(server);
    await listenTcp(server);
    const address = server.address() as AddressInfo;
    await Effect.runPromise(
      writeWorkerRecord(
        app,
        { userDataRoot: root },
        {
          appId: app.id,
          appRoot: app.root,
          transport: "tcp-host-gateway",
          url: `http://127.0.0.1:${address.port}`,
          containerUrl,
          probeServices: ["appserver"],
          shimPath: join(root, "lando.exe"),
          protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
          startedAt: "2026-07-15T00:00:00.000Z",
          pid: process.pid,
          controlToken,
        },
      ),
    );
    let execCalls = 0;
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
      exec: () => {
        execCalls += 1;
        return Effect.die("provider exec must not run for a mismatched container gateway");
      },
    };

    // When
    const result = await runDoctor(root, provider);

    // Then
    const check = result.checks.find((candidate) => candidate.name === "host-proxy-transport");
    expect(check).toMatchObject({
      status: "warn",
      context: { reachability: "unreachable", failure: "container-gateway-mismatch" },
    });
    expect(execCalls).toBe(0);
  });

  test("redacts record-derived context before returning machine-readable doctor results", async () => {
    // Given
    const root = await tempRoot();
    const secret = "multi-format-secret-value";
    const app = { kind: "user" as const, id: `demo-${secret}`, root: AbsolutePath.make(join(root, "app")) };
    const socketPath = join(root, `${secret}.sock`);
    await Effect.runPromise(
      writeWorkerRecord(
        app,
        { userDataRoot: root },
        {
          appId: app.id,
          appRoot: app.root,
          transport: "unix-socket",
          socketPath,
          shimPath: join(root, secret),
          protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
          startedAt: "2026-07-15T00:00:00.000Z",
          pid: process.pid,
          controlToken: secret,
        },
      ),
    );

    // When
    const result = await runDoctor(root, TestRuntimeProvider, { LANDO_TEST_TOKEN: secret });

    // Then
    const json = JSON.stringify(result);
    const text = renderDoctorResult(result);
    const ndjson = renderDoctorResultAsNdjson(result, { now: new Date(0) });
    expect(json).not.toContain(secret);
    expect(text).not.toContain(secret);
    expect(ndjson).not.toContain(secret);
    expect(json).toContain("[redacted]");
  });

  test("proves TCP reachability from the persisted eligible service through its container alias", async () => {
    // Given
    const root = await tempRoot();
    const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make(join(root, "app")) };
    const controlToken = "control-token";
    const containerUrl = "http://host.containers.internal:32123";
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
          transport: "tcp-host-gateway",
          protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
          pid: process.pid,
        }),
      );
    });
    servers.push(server);
    await listenTcp(server);
    const address = server.address() as AddressInfo;
    await Effect.runPromise(
      writeWorkerRecord(
        app,
        { userDataRoot: root },
        {
          appId: app.id,
          appRoot: app.root,
          transport: "tcp-host-gateway",
          url: `http://127.0.0.1:${address.port}`,
          containerUrl,
          probeServices: ["stopped", "appserver"],
          shimPath: join(root, "lando.exe"),
          protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
          startedAt: "2026-07-15T00:00:00.000Z",
          pid: process.pid,
          controlToken,
        },
      ),
    );
    const calls: Array<{ readonly target: unknown; readonly command: unknown }> = [];
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
      exec: (
        target: Parameters<typeof TestRuntimeProvider.exec>[0],
        command: Parameters<typeof TestRuntimeProvider.exec>[1],
      ) => {
        calls.push({ target, command });
        if (target.service === "stopped")
          return Effect.succeed({ exitCode: 1, stdout: "", stderr: "service is stopped" });
        return Effect.succeed({
          exitCode: 0,
          stdout: JSON.stringify({
            apiVersion: "v4",
            command: "app:open",
            ok: true,
            result: {
              app: "demo",
              targets: [
                {
                  service: "appserver",
                  hostname: "demo.lndo.site",
                  scheme: "https",
                  url: "https://demo.lndo.site",
                },
              ],
              launch: "printed",
            },
            warnings: [],
            deprecations: [],
          }),
          stderr: "",
        });
      },
    };

    // When
    const result = await runDoctor(root, provider);

    // Then
    expect(result.checks.find((candidate) => candidate.name === "host-proxy-transport")).toMatchObject({
      status: "pass",
      context: { reachability: "reachable" },
      solutions: [],
    });
    expect(calls).toEqual([
      {
        target: { app: "demo", service: "stopped" },
        command: {
          command: ["/usr/local/bin/lando", "open", "--print"],
          env: { LANDO_HOST_PROXY_URL: containerUrl },
          stdin: "ignore",
          tty: false,
        },
      },
      {
        target: { app: "demo", service: "appserver" },
        command: {
          command: ["/usr/local/bin/lando", "open", "--print"],
          env: { LANDO_HOST_PROXY_URL: containerUrl },
          stdin: "ignore",
          tty: false,
        },
      },
    ]);
  });
});
