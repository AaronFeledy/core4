import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Context, Effect, Layer, Schema } from "effect";

import {
  ConfigService,
  PathsService,
  RouterService,
  RuntimeProviderRegistry,
  SshService,
} from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { makeLandoPaths } from "@lando/paths";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { ConfigError } from "@lando/sdk/errors";
import { AbsolutePath, GlobalConfig, ProviderId, type ProxyConfig } from "@lando/sdk/schema";
import { makeTestCertificateAuthority, makeTestRouterService, makeTestSshService } from "@lando/sdk/test";

import { CertificateAuthorityResolver } from "@lando/engine/plugins/certificate-authority-resolver";
import { PluginRegistryLive } from "@lando/engine/plugins/registry";
import {
  DoctorReportSchema,
  collectDoctorReport,
  doctorReport,
  renderDoctorReport,
  renderDoctorReportAsNdjson,
} from "../../src/cli/commands/doctor-report.ts";
import { DefaultSubsystemDoctorLayer, subsystemDoctor } from "../../src/cli/commands/doctor-subsystems.ts";
import { runWithRendererHandling } from "../../src/cli/renderer-boundary.ts";
import { CORE_VERSION } from "../../src/version.ts";

const makeConfig = (input: unknown = {}): GlobalConfig => Schema.decodeUnknownSync(GlobalConfig)(input);

const configService = (
  load: Effect.Effect<GlobalConfig, ConfigError>,
  fallback: GlobalConfig,
): Context.Tag.Service<typeof ConfigService> => ({
  load,
  get: (key) => Effect.succeed(fallback[key]),
});

const registryService: Context.Tag.Service<typeof RuntimeProviderRegistry> = {
  list: Effect.succeed([ProviderId.make(TestRuntimeProvider.id)]),
  capabilities: Effect.succeed(TestRuntimeProvider.capabilities),
  select: () => Effect.succeed(TestRuntimeProvider),
};

const runtimeLayer = (config: GlobalConfig) =>
  Layer.mergeAll(
    PluginRegistryLive,
    Layer.succeed(ConfigService, configService(Effect.succeed(config), config)),
    Layer.succeed(PathsService, makeLandoPaths({ platform: "linux", env: {} })),
    Layer.succeed(RuntimeProviderRegistry, registryService),
  );

describe("combined doctor certificate and network-trust wiring", () => {
  test("uses the optional resolver service and appends network trust after host proxy", async () => {
    // Given
    const config = makeConfig({});
    const authority = { ...makeTestCertificateAuthority(), id: "mkcert-selected" };
    const layer = Layer.mergeAll(
      runtimeLayer(config),
      Layer.succeed(CertificateAuthorityResolver, { resolve: Effect.succeed(authority) }),
    );

    // When
    const report = await Effect.runPromise(doctorReport({ env: {} }).pipe(Effect.provide(layer)));

    // Then
    expect(report.subsystems.checks.map((check) => check.name)).toEqual([
      "router",
      "certs",
      "ssh",
      "healthcheck",
      "scanner",
      "host-proxy",
      "network-trust",
    ]);
    expect(report.subsystems.checks[1]).toMatchObject({
      name: "certs",
      status: "pass",
      context: { subsystemId: "mkcert-selected", ready: "true" },
    });
    expect(report.subsystems.checks[6]).toMatchObject({
      name: "network-trust",
      status: "pass",
      severity: "info",
      recovery: "manual",
    });
  });

  test("honors an injected certificate status effect during report collection", async () => {
    // Given
    const config = makeConfig({});

    // When
    const report = await Effect.runPromise(
      collectDoctorReport({
        options: {},
        provider: Effect.succeed({ checks: [] }),
        deprecations: Effect.succeed({ entries: [] }),
        certs: Effect.succeed({ _tag: "selected", id: "injected-ca" }),
      }).pipe(Effect.provide(Layer.succeed(ConfigService, configService(Effect.succeed(config), config)))),
    );

    // Then
    expect(report.version).toBe(CORE_VERSION);
    expect(renderDoctorReport(report)).toContain(`version: ${CORE_VERSION}`);
    expect(report.subsystems.checks.find((check) => check.name === "certs")?.context.subsystemId).toBe(
      "injected-ca",
    );
  });

  test("DoctorReportSchema requires version", () => {
    expect(() =>
      Schema.decodeUnknownSync(DoctorReportSchema)({
        provider: { checks: [] },
        subsystems: { checks: [] },
        globalApp: { checks: [] },
        mcp: { checks: [] },
      }),
    ).toThrow();
  });

  test("redacts a failing network trust path in every format and keeps the report schema stable", async () => {
    // Given
    const secret = "doctor-network-secret";
    const path = `/unreadable/${secret}/corp-root.pem`;
    const redactedPath = "/unreadable/[redacted]/corp-root.pem";
    const config = makeConfig({ network: { ca: { certs: [path] } } });

    // When
    const report = await Effect.runPromise(
      doctorReport({ env: { LANDO_TEST_SECRET: secret } }).pipe(Effect.provide(runtimeLayer(config))),
    );

    // Then
    const networkTrust = report.subsystems.checks.at(-1);
    expect(networkTrust).toMatchObject({
      name: "network-trust",
      status: "warn",
      severity: "warn",
      recovery: "manual",
      context: { failure: "missing-custom-ca" },
      solutions: [{ kind: "manual", command: "lando setup" }],
    });
    const io = createBufferedRendererIO();
    await runWithRendererHandling(Effect.succeed(report), {
      runtime: Layer.empty,
      rendererMode: "plain",
      resultFormat: "yaml",
      command: "meta:doctor",
      resultSchema: DoctorReportSchema,
      io,
      render: () => undefined,
      formatError: String,
    });
    expect(
      (
        Bun.YAML.parse(io.stdout()) as {
          readonly result: { readonly subsystems: { readonly checks: ReadonlyArray<unknown> } };
        }
      ).result.subsystems.checks.at(-1),
    ).toEqual(networkTrust);
    for (const output of [renderDoctorReport(report), io.stdout(), renderDoctorReportAsNdjson(report)]) {
      expect(output).toContain(redactedPath);
      expect(output).not.toContain(secret);
      expect(output).not.toContain(path);
    }
    const encoded = Schema.encodeSync(DoctorReportSchema)(report);
    expect(() => Schema.decodeUnknownSync(DoctorReportSchema)(encoded)).not.toThrow();
  });

  test("isolates ConfigService failure to network trust while retaining six base subsystem checks", async () => {
    // Given
    const config = makeConfig({});
    const failure = new ConfigError({ message: "network config unavailable", path: "/config.yml" });
    const layer = Layer.succeed(ConfigService, configService(Effect.fail(failure), config));

    // When
    const report = await Effect.runPromise(
      collectDoctorReport({
        options: {},
        provider: Effect.succeed({ checks: [] }),
        deprecations: Effect.succeed({ entries: [] }),
      }).pipe(Effect.provide(layer)),
    );

    // Then
    expect(report.subsystems.checks.map((check) => check.name)).toEqual([
      "router",
      "certs",
      "ssh",
      "healthcheck",
      "scanner",
      "host-proxy",
    ]);
    expect(report.self?.checks).toContainEqual(
      expect.objectContaining({ section: "network-trust", reason: "failure" }),
    );
  });
});

const mentionsUnavailableStub = (value: unknown): boolean => {
  const dump = JSON.stringify(value);
  return dump.includes("full implementation is not available yet") || dump.includes("not available yet");
};

describe("runtime-wired subsystem doctor", () => {
  test("uses injected Traefik running + SSH sidecar instead of unavailable stubs", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "doctor-report-agent-"));
    const socketPath = join(root, "agent.sock");
    const server = createServer((socket) =>
      socket.once("data", () => socket.end(Buffer.from([0, 0, 0, 5, 12, 0, 0, 0, 0]))),
    );
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      const config = makeConfig({});
      const proxy = { ...makeTestRouterService(), id: "traefik" };
      await Effect.runPromise(Effect.scoped(proxy.setup({ defaultDomain: "lndo.site" })));
      const wired = Layer.mergeAll(
        Layer.succeed(RouterService, proxy),
        Layer.succeed(SshService, {
          ...makeTestSshService(),
          id: "sidecar",
          getAgentSocket: (appId) => Effect.succeed({ appId, socketPath: AbsolutePath.make(socketPath) }),
        }),
        Layer.succeed(RuntimeProviderRegistry, {
          ...registryService,
          capabilities: Effect.succeed({
            ...TestRuntimeProvider.capabilities,
            agentSocket: { delivery: "bind-directory" as const },
          }),
        }),
      );

      // When
      const report = await Effect.runPromise(
        collectDoctorReport({
          options: {},
          provider: Effect.succeed({ checks: [] }),
          deprecations: Effect.succeed({ entries: [] }),
          subsystems: (options) =>
            subsystemDoctor(options).pipe(Effect.provide(wired), Effect.provide(DefaultSubsystemDoctorLayer)),
        }).pipe(Effect.provide(Layer.succeed(ConfigService, configService(Effect.succeed(config), config)))),
      );

      // Then
      const proxyCheck = report.subsystems.checks.find((check) => check.name === "router");
      const sshCheck = report.subsystems.checks.find((check) => check.name === "ssh");
      expect(proxyCheck).toMatchObject({
        status: "pass",
        context: { subsystemId: "traefik", ready: "true", state: "running" },
      });
      expect(sshCheck).toMatchObject({
        status: "pass",
        context: { subsystemId: "sidecar", ready: "true" },
      });
      expect(mentionsUnavailableStub(report.subsystems)).toBe(false);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  });

  test("--fix invokes the injected stopped Traefik setup, not RouterServiceUnavailableLive", async () => {
    // Given
    const config = makeConfig({});
    let setupCalls = 0;
    const proxyService = makeTestRouterService();
    const stoppedTraefik = {
      ...proxyService,
      id: "traefik",
      setup: (setupConfig: ProxyConfig) =>
        Effect.tap(proxyService.setup(setupConfig), () =>
          Effect.sync(() => {
            setupCalls += 1;
          }),
        ),
    };
    const wired = Layer.mergeAll(
      Layer.succeed(RouterService, stoppedTraefik),
      Layer.succeed(SshService, { ...makeTestSshService(), id: "sidecar" }),
    );

    // When
    const report = await Effect.runPromise(
      collectDoctorReport({
        options: { fix: true },
        provider: Effect.succeed({ checks: [] }),
        deprecations: Effect.succeed({ entries: [] }),
        subsystems: (options) =>
          subsystemDoctor(options).pipe(Effect.provide(wired), Effect.provide(DefaultSubsystemDoctorLayer)),
      }).pipe(Effect.provide(Layer.succeed(ConfigService, configService(Effect.succeed(config), config)))),
    );

    // Then
    const proxyCheck = report.subsystems.checks.find((check) => check.name === "router");
    expect(setupCalls).toBe(1);
    expect(proxyCheck).toMatchObject({
      status: "pass",
      context: { subsystemId: "traefik", ready: "true", state: "running", fixOutcome: "recovered" },
    });
    expect(proxyCheck?.context.state).not.toBe("stopped");
    expect(proxyCheck?.context.fixError).toBeUndefined();
    expect(mentionsUnavailableStub(report.subsystems)).toBe(false);
  });
});
