import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Context, Effect, Layer } from "effect";

import { ConfigService, RuntimeProviderRegistry } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/core/testing";
import type { RuntimeServiceStatus } from "@lando/provider-lando";
import { AbsolutePath, type GlobalConfig, ProviderId } from "@lando/sdk/schema";
import type { RuntimeProviderShape } from "@lando/sdk/services";

import { type DoctorCheck, doctor, renderDoctorResult } from "../../src/cli/commands/doctor.ts";
import { type SetupReadinessStep, writeSetupReadiness } from "../../src/cli/commands/setup-readiness.ts";

interface RuntimeServiceTestProvider extends RuntimeProviderShape {
  readonly getRuntimeServiceStatus?: Effect.Effect<RuntimeServiceStatus, unknown>;
}

const steps = [
  {
    id: "provider",
    status: "satisfied",
    evidence: "provider setup is satisfied",
  },
] satisfies ReadonlyArray<SetupReadinessStep>;

const buildRegistry = (provider: RuntimeServiceTestProvider) => ({
  list: Effect.succeed([ProviderId.make(provider.id)]),
  capabilities: Effect.succeed(provider.capabilities),
  select: () => Effect.succeed(provider),
});

const buildConfigService = (
  overrides: Partial<GlobalConfig> = {},
): Context.Tag.Service<typeof ConfigService> => {
  const config: GlobalConfig = {
    defaultProviderId: ProviderId.make("lando"),
    telemetry: { enabled: false },
    ...overrides,
  } as GlobalConfig;
  const load = Effect.succeed(config);
  return {
    load,
    get: (key) => Effect.map(load, (loadedConfig) => loadedConfig[key]),
  };
};

const buildLayers = (
  provider: RuntimeServiceTestProvider,
  configOverrides: Partial<GlobalConfig> = {},
): Layer.Layer<ConfigService | RuntimeProviderRegistry> =>
  Layer.merge(
    Layer.succeed(RuntimeProviderRegistry, buildRegistry(provider)),
    Layer.succeed(ConfigService, buildConfigService(configOverrides)),
  );

const runtimeServiceCheck = async (
  provider: RuntimeServiceTestProvider,
  configOverrides: Partial<GlobalConfig> = {},
): Promise<DoctorCheck> => {
  const result = await Effect.runPromise(
    doctor().pipe(Effect.provide(buildLayers(provider, configOverrides))),
  );
  const check = result.checks.find((candidate) => candidate.name === "runtime-service");
  expect(check).toBeDefined();
  return check as DoctorCheck;
};

describe("meta:doctor runtime-service check", () => {
  test("uses getRuntimeServiceStatus when present", async () => {
    const provider: RuntimeServiceTestProvider = {
      ...TestRuntimeProvider,
      id: "lando",
      getStatus: Effect.succeed({ running: false, message: "stale stopped" }),
      getRuntimeServiceStatus: Effect.succeed({
        running: true,
        socketReachable: true,
        pid: 1234,
        ownedServiceProcess: true,
      }),
    };

    const check = await runtimeServiceCheck(provider);

    expect(check.status).toBe("pass");
    expect(check.runtime.running).toBe(true);
    expect(check.runtime.version).toBe("0.0.0-test");
    expect(check.context.runtimeRunning).toBe("true");
    expect(check.context.socketReachable).toBe("true");
    expect(check.context.ownedServiceProcess).toBe("true");
    expect(check.context.runtimePid).toBe("1234");
  });

  test("falls back to getStatus when getRuntimeServiceStatus is absent", async () => {
    const provider: RuntimeServiceTestProvider = {
      ...TestRuntimeProvider,
      id: "lando",
      getStatus: Effect.succeed({ running: false, message: "provider stopped" }),
    };

    const check = await runtimeServiceCheck(provider);

    expect(check.status).toBe("warn");
    expect(check.runtime.running).toBe(false);
    expect(check.context.runtimeRunning).toBe("false");
    expect(check.context.socketReachable).toBe("false");
    expect(check.context.ownedServiceProcess).toBe("false");
  });

  test("falls back to getStatus when getRuntimeServiceStatus fails", async () => {
    const provider: RuntimeServiceTestProvider = {
      ...TestRuntimeProvider,
      id: "lando",
      getStatus: Effect.succeed({ running: true, message: "provider running" }),
      getRuntimeServiceStatus: Effect.fail(new Error("status unavailable")),
    };

    const check = await runtimeServiceCheck(provider);

    expect(check.status).toBe("pass");
    expect(check.runtime.running).toBe(true);
    expect(check.context.runtimeRunning).toBe("true");
    expect(check.context.socketReachable).toBe("true");
    expect(check.context.ownedServiceProcess).toBe("false");
  });

  test("warns with remediation on orphan pid", async () => {
    const provider: RuntimeServiceTestProvider = {
      ...TestRuntimeProvider,
      id: "lando",
      getRuntimeServiceStatus: Effect.succeed({
        running: true,
        socketReachable: true,
        pid: 1234,
        ownedServiceProcess: true,
        orphanPids: [9999],
      }),
    };

    const check = await runtimeServiceCheck(provider);

    expect(check.status).toBe("warn");
    expect(check.severity).toBe("warn");
    expect(check.context.orphanPids).toContain("9999");
    expect(check.solutions[0]?.kind).toBe("manual");
    expect(check.solutions[0]?.description).toContain("9999");
    expect(check.solutions[0]?.description).toContain("Terminate them manually");
    expect(check.solutions[0]?.command).toBeUndefined();
  });

  test("surfaces readiness runtimeService as last-recorded context", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-doctor-runtime-service-"));
    try {
      await Effect.runPromise(
        writeSetupReadiness(dataRoot, "lando", steps, {
          running: true,
          socketPath: "/home/u/.local/share/lando/runtime/run/podman.sock",
          pid: 2468,
          runtimeVersion: "5.0.0",
        }),
      );
      const provider: RuntimeServiceTestProvider = {
        ...TestRuntimeProvider,
        id: "lando",
        getRuntimeServiceStatus: Effect.succeed({
          running: true,
          socketReachable: true,
          ownedServiceProcess: true,
        }),
      };

      const check = await runtimeServiceCheck(provider, { userDataRoot: AbsolutePath.make(dataRoot) });

      expect(check.context.lastRecordedRunning).toBe("true");
      expect(check.context.lastRecordedSocketPath).toBe("/home/u/.local/share/lando/runtime/run/podman.sock");
      expect(check.context.lastRecordedPid).toBe("2468");
      expect(check.context.lastRecordedRuntimeVersion).toBe("5.0.0");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  test("redacts readiness socket path in context", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "lando-doctor-runtime-service-redact-"));
    try {
      await Effect.runPromise(
        writeSetupReadiness(dataRoot, "lando", steps, {
          running: true,
          socketPath:
            "/home/u/.local/share/lando/runtime/run/podman.sock?token=ABC123&X-Amz-Signature=deadbeef",
          pid: 2468,
        }),
      );
      const provider: RuntimeServiceTestProvider = {
        ...TestRuntimeProvider,
        id: "lando",
        getRuntimeServiceStatus: Effect.succeed({
          running: true,
          socketReachable: true,
          ownedServiceProcess: true,
        }),
      };

      const result = await Effect.runPromise(
        doctor().pipe(Effect.provide(buildLayers(provider, { userDataRoot: AbsolutePath.make(dataRoot) }))),
      );
      const check = result.checks.find((candidate) => candidate.name === "runtime-service");
      const text = renderDoctorResult(result);

      expect(check?.context.lastRecordedSocketPath).toBe(
        "/home/u/.local/share/lando/runtime/run/podman.sock?token=[redacted]&X-Amz-Signature=[redacted]",
      );
      expect(text).toContain("lastRecordedSocketPath:");
      expect(text).toContain("[redacted]");
      expect(text).not.toContain("ABC123");
      expect(text).not.toContain("deadbeef");
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });
});
