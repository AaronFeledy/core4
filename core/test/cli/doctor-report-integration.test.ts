import { describe, expect, test } from "bun:test";

import { type Context, Effect, Layer, Schema } from "effect";

import {
  ConfigService,
  PathsService,
  ProxyService,
  RuntimeProviderRegistry,
  SshService,
} from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import { makeLandoPaths } from "@lando/paths";
import { ConfigError } from "@lando/sdk/errors";
import { GlobalConfig, ProviderId } from "@lando/sdk/schema";
import { makeTestCertificateAuthority, makeTestProxyService, makeTestSshService } from "@lando/sdk/test";

import {
  DoctorReportSchema,
  collectDoctorReport,
  doctorReport,
  renderDoctorReport,
  renderDoctorReportAsNdjson,
  renderDoctorReportAsYaml,
} from "../../src/cli/commands/doctor-report.ts";
import { DefaultSubsystemDoctorLayer, subsystemDoctor } from "../../src/cli/commands/doctor-subsystems.ts";
import { CertificateAuthorityResolver } from "../../src/testing/engine-layers.ts";

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
      "proxy",
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
    expect(report.subsystems.checks.find((check) => check.name === "certs")?.context.subsystemId).toBe(
      "injected-ca",
    );
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
    for (const output of [
      renderDoctorReport(report),
      renderDoctorReportAsYaml(report),
      renderDoctorReportAsNdjson(report),
    ]) {
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
      "proxy",
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
    // Given a provider-shaped layer with selected, running proxy and sidecar SSH
    const config = makeConfig({});
    const proxy = { ...makeTestProxyService(), id: "traefik" };
    await Effect.runPromise(Effect.scoped(proxy.setup({ defaultDomain: "lndo.site" })));
    const wired = Layer.mergeAll(
      Layer.succeed(ProxyService, proxy),
      Layer.succeed(SshService, { ...makeTestSshService(), id: "sidecar" }),
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
    const proxyCheck = report.subsystems.checks.find((check) => check.name === "proxy");
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
  });

  test("--fix invokes the injected stopped Traefik setup, not ProxyServiceUnavailableLive", async () => {
    // Given a selected Traefik proxy that is stopped
    const config = makeConfig({});
    let setupCalls = 0;
    const stoppedTraefik = {
      ...makeTestProxyService(),
      id: "traefik",
      setup: () =>
        Effect.sync(() => {
          setupCalls += 1;
        }),
    };
    const wired = Layer.mergeAll(
      Layer.succeed(ProxyService, stoppedTraefik),
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
    const proxyCheck = report.subsystems.checks.find((check) => check.name === "proxy");
    expect(setupCalls).toBe(1);
    expect(proxyCheck).toMatchObject({
      status: "pass",
      context: { subsystemId: "traefik", ready: "true", fixOutcome: "recovered" },
    });
    expect(proxyCheck?.context.fixError).toBeUndefined();
    expect(mentionsUnavailableStub(report.subsystems)).toBe(false);
  });
});
