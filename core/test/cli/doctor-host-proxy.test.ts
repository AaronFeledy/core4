import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { type Context, Deferred, Effect, Fiber, Layer, Option, TestClock, TestContext } from "effect";

import { ConfigService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { ServiceExecError } from "@lando/sdk/errors";
import { AbsolutePath, type GlobalConfig, ProviderId } from "@lando/sdk/schema";

import {
  buildHostProxyAllowlistDoctorCheck,
  hostProxyAllowlistFreshness,
} from "../../src/cli/commands/doctor-host-proxy-allowlist.ts";
import {
  HostProxyDoctorFileSystem,
  HostProxyDoctorFileSystemLive,
} from "../../src/cli/commands/doctor-host-proxy-filesystem.ts";
import { hostProxyTransportDoctorChecks } from "../../src/cli/commands/doctor-host-proxy.ts";
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
    expect(result.checks.some((check) => check.name === "host-proxy-state")).toBe(false);
  });

  test("warns when the host-proxy worker root is unreadable as a directory", async () => {
    // Given
    const root = await tempRoot();
    const secret = "unreadable-root-secret";
    const userDataRoot = join(root, secret);
    const hostProxyRunRoot = makeLandoPaths({ userDataRoot }).hostProxyRunRoot;
    await mkdir(dirname(hostProxyRunRoot), { recursive: true });
    await writeFile(hostProxyRunRoot, "not-a-directory\n");

    // When
    const result = await runDoctor(userDataRoot, TestRuntimeProvider, { LANDO_TEST_TOKEN: secret });

    // Then
    const check = result.checks.find((candidate) => candidate.name === "host-proxy-state");
    expect(check).toMatchObject({
      status: "warn",
      severity: "warn",
      context: {
        workerState: "unreadable",
        reason: "worker-root-unreadable",
        errorCode: "ENOTDIR",
      },
      solutions: [
        {
          kind: "manual",
          description:
            "The persisted host-proxy worker state is unreadable or malformed. Inspect or remove that worker state, then retry.",
        },
      ],
    });
    const text = renderDoctorResult(result);
    const ndjson = renderDoctorResultAsNdjson(result, { now: new Date(0) });
    expect(text).toContain("host-proxy-state: warn");
    expect(text).toContain("workerState: unreadable");
    expect(text).not.toContain(secret);
    expect(ndjson).not.toContain(secret);
  });

  test("reports a pre-upgrade TCP worker without probe metadata as informational", async () => {
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
          providerId: String(TestRuntimeProvider.id),
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
      status: "pass",
      severity: "info",
      context: {
        appId: "demo",
        transport: "tcp-host-gateway",
        reachability: "not-probed",
        endpoint: "missing",
        containerGateway: "host.containers.internal",
        reason: "pre-upgrade-record",
      },
      solutions: [],
    });

    const text = renderDoctorResult(result);
    const ndjson = renderDoctorResultAsNdjson(result, {
      now: new Date("1970-01-01T00:00:00.000Z"),
    });
    expect(text).toContain("host-proxy-transport: pass");
    expect(text).toContain("reason: pre-upgrade-record");
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
          providerId: String(TestRuntimeProvider.id),
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
          providerId: String(TestRuntimeProvider.id),
          transport: "tcp-host-gateway",
          url: `http://127.0.0.1:${address.port}`,
          containerUrl,
          probeServices: ["a-stopped", "b-broken", "c-appserver"],
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
        if (target.service === "a-stopped")
          return Effect.succeed({ exitCode: 1, stdout: "", stderr: "service is stopped" });
        if (target.service === "b-broken")
          return Effect.succeed({ exitCode: 127, stdout: "", stderr: "host proxy unavailable" });
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
        target: { app: "demo", service: "a-stopped" },
        command: {
          command: ["/usr/local/bin/lando", "open", "--print"],
          env: { LANDO_HOST_PROXY_URL: containerUrl },
          stdin: "ignore",
          tty: false,
        },
      },
      {
        target: { app: "demo", service: "b-broken" },
        command: {
          command: ["/usr/local/bin/lando", "open", "--print"],
          env: { LANDO_HOST_PROXY_URL: containerUrl },
          stdin: "ignore",
          tty: false,
        },
      },
      {
        target: { app: "demo", service: "c-appserver" },
        command: {
          command: ["/usr/local/bin/lando", "open", "--print"],
          env: { LANDO_HOST_PROXY_URL: containerUrl },
          stdin: "ignore",
          tty: false,
        },
      },
    ]);
  });

  test("reports malformed worker state through redacted text and NDJSON context", async () => {
    // Given
    const root = await tempRoot();
    const secret = "malformed-state-secret";
    const runDir = join(makeLandoPaths({ userDataRoot: root }).hostProxyRunRoot, secret);
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "worker.json"), "{not-json\n");

    // When
    const result = await runDoctor(root, TestRuntimeProvider, { LANDO_TEST_TOKEN: secret });

    // Then
    const check = result.checks.find((candidate) => candidate.name === "host-proxy-state");
    expect(check).toMatchObject({
      status: "warn",
      severity: "warn",
      context: { workerState: "malformed" },
    });
    const text = renderDoctorResult(result);
    const ndjson = renderDoctorResultAsNdjson(result, { now: new Date(0) });
    expect(text).toContain("host-proxy-state: warn");
    expect(text).toContain("workerState: malformed");
    expect(text).not.toContain(secret);
    expect(ndjson).not.toContain(secret);
  });

  test("treats a schema-valid app:open error envelope as transport reachability proof", async () => {
    // Given
    const root = await tempRoot();
    const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make(join(root, "app")) };
    const controlToken = "control-token";
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
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP test address.");
    const containerUrl = "http://host.containers.internal:32123";
    await Effect.runPromise(
      writeWorkerRecord(
        app,
        { userDataRoot: root },
        {
          appId: app.id,
          appRoot: app.root,
          providerId: String(TestRuntimeProvider.id),
          transport: "tcp-host-gateway",
          url: `http://127.0.0.1:${address.port}`,
          containerUrl,
          probeServices: ["appserver"],
          shimPath: join(root, "lando"),
          protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
          startedAt: "2026-07-15T00:00:00.000Z",
          pid: process.pid,
          controlToken,
        },
      ),
    );
    const commands: unknown[] = [];
    const provider = {
      ...TestRuntimeProvider,
      tcpHostGateway: "host.containers.internal",
      capabilities: {
        ...TestRuntimeProvider.capabilities,
        hostProxy: {
          containerTargets: [{ os: "linux" as const, arch: "x64" as const }],
          tcpHostGateway: "host.containers.internal",
        },
      },
      exec: (
        _target: Parameters<typeof TestRuntimeProvider.exec>[0],
        command: Parameters<typeof TestRuntimeProvider.exec>[1],
      ) => {
        commands.push(command.command);
        return Effect.succeed({
          exitCode: 1,
          stdout: JSON.stringify({
            apiVersion: "v4",
            command: "app:open",
            ok: false,
            error: { _tag: "LandoCommandError", message: "No routes matched." },
            warnings: [],
            deprecations: [],
          }),
          stderr: "No routes matched.",
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
    expect(commands).toEqual([["/usr/local/bin/lando", "open", "--print"]]);
  });

  test("does not execute a worker persisted for another provider", async () => {
    // Given
    const root = await tempRoot();
    const appRoot = AbsolutePath.make(join(root, "app"));
    const paths = makeLandoPaths({ userDataRoot: root });
    const runDir = paths.hostProxyRunDir("demo", appRoot);
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "worker.json"),
      `${JSON.stringify({
        appId: "demo",
        appRoot,
        providerId: "different-provider",
        transport: "tcp-host-gateway",
        url: "http://127.0.0.1:1",
        containerUrl: "http://host.containers.internal:32123",
        probeServices: ["appserver"],
        shimPath: join(root, "lando"),
        protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
        startedAt: "2026-07-15T00:00:00.000Z",
        pid: process.pid,
        controlToken: "control-token",
      })}\n`,
    );
    let execCalls = 0;
    const provider = {
      ...TestRuntimeProvider,
      tcpHostGateway: "host.containers.internal",
      capabilities: {
        ...TestRuntimeProvider.capabilities,
        hostProxy: {
          containerTargets: [{ os: "linux" as const, arch: "x64" as const }],
          tcpHostGateway: "host.containers.internal",
        },
      },
      exec: () => {
        execCalls += 1;
        return Effect.die("mismatched provider must not execute the worker");
      },
    };

    // When
    const result = await runDoctor(root, provider);

    // Then
    expect(result.checks.find((candidate) => candidate.name === "host-proxy-transport")).toMatchObject({
      status: "pass",
      severity: "info",
      context: {
        reachability: "not-probed",
        reason: "provider-mismatch",
        workerProviderId: "different-provider",
      },
      solutions: [],
    });
    expect(execCalls).toBe(0);
  });

  test("reports legacy TCP state without probe metadata as informational", async () => {
    // Given
    const root = await tempRoot();
    const appId = "legacy-tcp";
    const runDir = join(makeLandoPaths({ userDataRoot: root }).hostProxyRunRoot, sanitizeAppName(appId));
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "worker.json"),
      `${JSON.stringify({
        appId,
        transport: "tcp-host-gateway",
        url: "http://127.0.0.1:1",
        shimPath: join(root, "lando"),
        protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
        startedAt: "2026-07-15T00:00:00.000Z",
        pid: process.pid,
        controlToken: "control-token",
      })}\n`,
    );
    const provider = {
      ...TestRuntimeProvider,
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
    expect(result.checks.find((candidate) => candidate.name === "host-proxy-transport")).toMatchObject({
      status: "pass",
      severity: "info",
      context: { appId, reachability: "not-probed", reason: "pre-upgrade-record" },
      solutions: [],
    });
  });

  test("distinguishes an authenticated control failure from a container probe failure", async () => {
    // Given
    const root = await tempRoot();
    const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make(join(root, "app")) };
    await Effect.runPromise(
      writeWorkerRecord(
        app,
        { userDataRoot: root },
        {
          appId: app.id,
          appRoot: app.root,
          providerId: String(TestRuntimeProvider.id),
          transport: "tcp-host-gateway",
          url: "http://127.0.0.1:1",
          containerUrl: "http://host.containers.internal:32123",
          probeServices: ["appserver"],
          shimPath: join(root, "lando"),
          protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
          startedAt: "2026-07-15T00:00:00.000Z",
          pid: process.pid,
          controlToken: "control-token",
        },
      ),
    );
    const provider = {
      ...TestRuntimeProvider,
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
    expect(result.checks.find((candidate) => candidate.name === "host-proxy-transport")).toMatchObject({
      status: "warn",
      context: { failure: "control-probe-failed" },
    });
  });

  test("caps and sorts persisted worker state before diagnosis", async () => {
    // Given
    const root = await tempRoot();
    const paths = makeLandoPaths({ userDataRoot: root });
    for (const name of ["worker-c", "worker-a", "worker-b"]) {
      const runDir = join(paths.hostProxyRunRoot, name);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "worker.json"), "{not-json\n");
    }

    // When
    const checks = await Effect.runPromise(
      hostProxyTransportDoctorChecks({
        userDataRoot: root,
        provider: TestRuntimeProvider,
        providerKind: "user-installed",
        runtimeStatus: "ready",
        runtime: { running: true },
        selection: {
          providerId: TestRuntimeProvider.id,
          source: "default",
          inputs: { capabilityDefault: TestRuntimeProvider.id },
        },
        limits: { maxWorkers: 2, maxProbeServices: 8, budgetMs: 1_000 },
      }).pipe(Effect.provide(HostProxyDoctorFileSystemLive)),
    );

    // Then
    expect(
      checks.filter((check) => check.name === "host-proxy-state").map((check) => check.context.statePath),
    ).toEqual([
      join(paths.hostProxyRunRoot, "worker-a", "worker.json"),
      join(paths.hostProxyRunRoot, "worker-b", "worker.json"),
    ]);
  });

  test("caps workers using locale-independent code-point order", async () => {
    // Given
    const root = await tempRoot();
    const paths = makeLandoPaths({ userDataRoot: root });
    for (const name of ["ä-worker", "z-worker"]) {
      const runDir = join(paths.hostProxyRunRoot, name);
      await mkdir(runDir, { recursive: true });
      await writeFile(join(runDir, "worker.json"), "{not-json\n");
    }

    // When
    const checks = await Effect.runPromise(
      hostProxyTransportDoctorChecks({
        userDataRoot: root,
        provider: TestRuntimeProvider,
        providerKind: "user-installed",
        runtimeStatus: "ready",
        runtime: { running: true },
        selection: {
          providerId: TestRuntimeProvider.id,
          source: "default",
          inputs: { capabilityDefault: TestRuntimeProvider.id },
        },
        limits: { maxWorkers: 1, maxProbeServices: 8, budgetMs: 1_000 },
      }).pipe(Effect.provide(HostProxyDoctorFileSystemLive)),
    );

    // Then
    expect(checks.find((check) => check.name === "host-proxy-state")?.context.statePath).toBe(
      join(paths.hostProxyRunRoot, "z-worker", "worker.json"),
    );
  });

  test("caps and sorts persisted probe services", async () => {
    // Given
    const root = await tempRoot();
    const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make(join(root, "app")) };
    const controlToken = "control-token";
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
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP test address.");
    const services = Array.from(
      { length: 10 },
      (_, index) => `service-${String(9 - index).padStart(2, "0")}`,
    );
    await Effect.runPromise(
      writeWorkerRecord(
        app,
        { userDataRoot: root },
        {
          appId: app.id,
          appRoot: app.root,
          providerId: String(TestRuntimeProvider.id),
          transport: "tcp-host-gateway",
          url: `http://127.0.0.1:${address.port}`,
          containerUrl: "http://host.containers.internal:32123",
          probeServices: services,
          shimPath: join(root, "lando"),
          protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
          startedAt: "2026-07-15T00:00:00.000Z",
          pid: process.pid,
          controlToken,
        },
      ),
    );
    const calls: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      capabilities: {
        ...TestRuntimeProvider.capabilities,
        hostProxy: {
          containerTargets: [{ os: "linux" as const, arch: "x64" as const }],
          tcpHostGateway: "host.containers.internal",
        },
      },
      exec: (target: Parameters<typeof TestRuntimeProvider.exec>[0]) => {
        calls.push(String(target.service));
        return Effect.succeed({ exitCode: 1, stdout: "not-an-envelope", stderr: "failed" });
      },
    };

    // When
    await runDoctor(root, provider);

    // Then
    expect(calls).toEqual(
      Array.from({ length: 8 }, (_, index) => `service-${String(index).padStart(2, "0")}`),
    );
  });

  test("reports stopped and unavailable probe services as informational inconclusive", async () => {
    // Given
    const root = await tempRoot();
    const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make(join(root, "app")) };
    const controlToken = "control-token";
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
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP test address.");
    await Effect.runPromise(
      writeWorkerRecord(
        app,
        { userDataRoot: root },
        {
          appId: app.id,
          appRoot: app.root,
          providerId: String(TestRuntimeProvider.id),
          transport: "tcp-host-gateway",
          url: `http://127.0.0.1:${address.port}`,
          containerUrl: "http://host.containers.internal:32123",
          probeServices: ["stopped", "unavailable"],
          shimPath: join(root, "lando"),
          protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
          startedAt: "2026-07-15T00:00:00.000Z",
          pid: process.pid,
          controlToken,
        },
      ),
    );
    const calls: string[] = [];
    const provider = {
      ...TestRuntimeProvider,
      capabilities: {
        ...TestRuntimeProvider.capabilities,
        hostProxy: {
          containerTargets: [{ os: "linux" as const, arch: "x64" as const }],
          tcpHostGateway: "host.containers.internal",
        },
      },
      exec: (target: Parameters<typeof TestRuntimeProvider.exec>[0]) => {
        calls.push(String(target.service));
        if (target.service === "stopped")
          return Effect.succeed({ exitCode: 1, stdout: "", stderr: "service is stopped" });
        return Effect.fail(
          new ServiceExecError({
            providerId: TestRuntimeProvider.id,
            operation: "exec",
            service: target.service,
            message: "service is unavailable",
          }),
        );
      },
    };

    // When
    const result = await runDoctor(root, provider);

    // Then
    expect(result.checks.find((candidate) => candidate.name === "host-proxy-transport")).toMatchObject({
      status: "pass",
      severity: "info",
      context: { reachability: "not-probed", reason: "probe-services-inconclusive" },
      solutions: [],
    });
    expect(calls).toEqual(["stopped", "unavailable"]);
  });

  test("warns when app:open exits 127 without a valid envelope", async () => {
    // Given
    const root = await tempRoot();
    const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make(join(root, "app")) };
    const controlToken = "control-token";
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
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP test address.");
    await Effect.runPromise(
      writeWorkerRecord(
        app,
        { userDataRoot: root },
        {
          appId: app.id,
          appRoot: app.root,
          providerId: String(TestRuntimeProvider.id),
          transport: "tcp-host-gateway",
          url: `http://127.0.0.1:${address.port}`,
          containerUrl: "http://host.containers.internal:32123",
          probeServices: ["appserver"],
          shimPath: join(root, "lando"),
          protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
          startedAt: "2026-07-15T00:00:00.000Z",
          pid: process.pid,
          controlToken,
        },
      ),
    );
    const provider = {
      ...TestRuntimeProvider,
      capabilities: {
        ...TestRuntimeProvider.capabilities,
        hostProxy: {
          containerTargets: [{ os: "linux" as const, arch: "x64" as const }],
          tcpHostGateway: "host.containers.internal",
        },
      },
      exec: () => Effect.succeed({ exitCode: 127, stdout: "", stderr: "lando: not found" }),
    };

    // When
    const result = await runDoctor(root, provider);

    // Then
    expect(result.checks.find((candidate) => candidate.name === "host-proxy-transport")).toMatchObject({
      status: "warn",
      severity: "warn",
      context: { reachability: "unreachable", failure: "container-probe-failed" },
    });
  });

  test("ends aggregate diagnosis at its overall budget without a false warning", async () => {
    // Given
    const root = await tempRoot();
    const app = { kind: "user" as const, id: "demo", root: AbsolutePath.make(join(root, "app")) };
    const controlToken = "control-token";
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
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Expected TCP test address.");
    const malformedRunDir = join(makeLandoPaths({ userDataRoot: root }).hostProxyRunRoot, "000-malformed");
    const probeStarted = Effect.runSync(Deferred.make<void>());
    await mkdir(malformedRunDir, { recursive: true });
    await writeFile(join(malformedRunDir, "worker.json"), "{not-json\n");
    await Effect.runPromise(
      writeWorkerRecord(
        app,
        { userDataRoot: root },
        {
          appId: app.id,
          appRoot: app.root,
          providerId: String(TestRuntimeProvider.id),
          transport: "tcp-host-gateway",
          url: `http://127.0.0.1:${address.port}`,
          containerUrl: "http://host.containers.internal:32123",
          probeServices: ["appserver"],
          shimPath: join(root, "lando"),
          protocolVersion: HOST_PROXY_WORKER_PROTOCOL_VERSION,
          startedAt: "2026-07-15T00:00:00.000Z",
          pid: process.pid,
          controlToken,
        },
      ),
    );
    const provider = {
      ...TestRuntimeProvider,
      tcpHostGateway: "host.containers.internal",
      capabilities: {
        ...TestRuntimeProvider.capabilities,
        hostProxy: {
          containerTargets: [{ os: "linux" as const, arch: "x64" as const }],
          tcpHostGateway: "host.containers.internal",
        },
      },
      exec: () =>
        Deferred.succeed(probeStarted, undefined).pipe(
          Effect.zipRight(Effect.sleep(75)),
          Effect.as({ exitCode: 1, stdout: "not-an-envelope", stderr: "failed" }),
        ),
    };

    // When
    const checks = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          hostProxyTransportDoctorChecks({
            userDataRoot: root,
            provider,
            providerKind: "user-installed",
            runtimeStatus: "ready",
            runtime: { running: true },
            selection: {
              providerId: TestRuntimeProvider.id,
              source: "default",
              inputs: { capabilityDefault: TestRuntimeProvider.id },
            },
            limits: { maxWorkers: 32, maxProbeServices: 8, budgetMs: 25 },
          }),
        );
        yield* Deferred.await(probeStarted);
        yield* TestClock.adjust("25 millis");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(HostProxyDoctorFileSystemLive), Effect.provide(TestContext.TestContext)),
    );

    // Then
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ name: "host-proxy-state", status: "warn" });
  });

  test("bounds root discovery with the aggregate Effect-clock budget without a false warning", async () => {
    // Given
    const root = await tempRoot();
    let rootReads = 0;
    const rootReadStarted = Effect.runSync(Deferred.make<void>());
    const fileSystem = Layer.succeed(HostProxyDoctorFileSystem, {
      readRoot: () =>
        Effect.gen(function* () {
          rootReads += 1;
          yield* Deferred.succeed(rootReadStarted, undefined);
          return yield* Effect.never;
        }),
      socketMetadata: () => Effect.succeed(undefined),
    });

    // When
    const checks = await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.fork(
          hostProxyTransportDoctorChecks({
            userDataRoot: root,
            provider: TestRuntimeProvider,
            providerKind: "user-installed",
            runtimeStatus: "ready",
            runtime: { running: true },
            selection: {
              providerId: TestRuntimeProvider.id,
              source: "default",
              inputs: { capabilityDefault: TestRuntimeProvider.id },
            },
            limits: { maxWorkers: 32, maxProbeServices: 8, budgetMs: 25 },
          }),
        );
        yield* Deferred.await(rootReadStarted);
        expect(rootReads).toBe(1);
        expect(Option.isNone(yield* Fiber.poll(fiber))).toBe(true);
        yield* TestClock.adjust("25 millis");
        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(fileSystem), Effect.provide(TestContext.TestContext)),
    );

    // Then
    expect(checks.some((check) => check.name === "host-proxy-state")).toBe(false);
    expect(checks.some((check) => check.name === "host-proxy-transport")).toBe(false);
  });
});
