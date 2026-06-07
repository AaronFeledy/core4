import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import { type ProviderCapabilities, ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceTypePlanInput, ServiceTypeShape } from "@lando/sdk/services";
import {
  ContractFailure,
  TestServiceType,
  runServiceContract,
  runServiceContractMatrix,
} from "@lando/sdk/test";

const TEST_PROVIDER_CAPABILITIES: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  copyOnWriteAppRoot: false,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const expectServiceContractFailure = async (
  serviceType: ServiceTypeShape,
  assertion: string,
  overrides?: {
    readonly landofileService?: Record<string, unknown>;
    readonly expectations?: Parameters<typeof runServiceContract>[0]["expectations"];
  },
): Promise<void> => {
  const result = await Effect.runPromiseExit(
    runServiceContract({
      serviceType,
      landofileService: overrides?.landofileService ?? { type: serviceType.id },
      providerId: ProviderId.make("test"),
      providerCapabilities: TEST_PROVIDER_CAPABILITIES,
      platform: "linux",
      expectations: overrides?.expectations ?? {
        type: serviceType.id,
        endpoints: [{ port: 8080, protocol: "tcp" }],
        healthcheck: { kind: "tcp", port: 8080 },
        defaultCredentialEnvKeys: [],
      },
    }),
  );

  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(result.cause._tag).toBe("Fail");
  if (result.cause._tag !== "Fail") return;
  expect(result.cause.error).toBeInstanceOf(ContractFailure);
  expect(result.cause.error._tag).toBe("ContractFailure");
  expect(result.cause.error.assertion).toBe(assertion);
};

describe("runServiceContract", () => {
  test("is exported as an Effect-returning contract helper", () => {
    expect(typeof runServiceContract).toBe("function");
  });

  test("TestServiceType passes the contract suite", async () => {
    const contract = runServiceContract({
      serviceType: TestServiceType,
      landofileService: { type: "test" },
      providerId: ProviderId.make("test"),
      providerCapabilities: TEST_PROVIDER_CAPABILITIES,
      platform: "linux",
      expectations: {
        type: "test",
        endpoints: [{ port: 8080, protocol: "tcp" }],
        healthcheck: { kind: "tcp", port: 8080 },
        defaultCredentialEnvKeys: [],
      },
    });

    expect(Effect.isEffect(contract)).toBe(true);
    await expect(Effect.runPromise(contract)).resolves.toBeUndefined();
  });

  test("fails with ContractFailure when service type id is empty", async () => {
    await expectServiceContractFailure({ ...TestServiceType, id: "" }, "service type exposes a non-empty id");
  });

  test("fails with ContractFailure when toServicePlan is not callable", async () => {
    const malformed = {
      ...TestServiceType,
      toServicePlan: undefined as unknown as ServiceTypeShape["toServicePlan"],
    };
    await expectServiceContractFailure(malformed, "service type toServicePlan is callable");
  });

  test("fails with ContractFailure when plan does not decode through the ServicePlan schema", async () => {
    const broken: ServiceTypeShape = {
      id: "test",
      toServicePlan: (_input) =>
        ({ name: "web" }) as unknown as ReturnType<ServiceTypeShape["toServicePlan"]>,
    };
    await expectServiceContractFailure(broken, "service plan decodes through the ServicePlan schema");
  });

  test("fails with ContractFailure when plan.type does not match expected", async () => {
    await expectServiceContractFailure(TestServiceType, "service plan type matches expectations", {
      expectations: {
        type: "not-test",
        endpoints: [{ port: 8080, protocol: "tcp" }],
        healthcheck: { kind: "tcp", port: 8080 },
        defaultCredentialEnvKeys: [],
      },
    });
  });

  test("fails with ContractFailure when plan.provider does not match providerId", async () => {
    const wrongProvider = makeMutatedServiceType((plan) => ({
      ...plan,
      provider: ProviderId.make("different"),
    }));
    await expectServiceContractFailure(wrongProvider, "service plan provider matches the requested provider");
  });

  test("fails with ContractFailure when provider capabilities do not support endpoints", async () => {
    const result = await Effect.runPromiseExit(
      runServiceContract({
        serviceType: TestServiceType,
        landofileService: { type: "test" },
        providerId: ProviderId.make("test"),
        providerCapabilities: { ...TEST_PROVIDER_CAPABILITIES, hostPortPublish: "none" },
        platform: "linux",
        expectations: {
          type: "test",
          endpoints: [{ port: 8080, protocol: "tcp" }],
          healthcheck: { kind: "tcp", port: 8080 },
          defaultCredentialEnvKeys: [],
        },
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.cause._tag).toBe("Fail");
    if (result.cause._tag !== "Fail") return;
    expect(result.cause.error.assertion).toBe(
      "service plan endpoint publishing is supported by provider capabilities",
    );
  });

  test("fails with ContractFailure when no endpoints are emitted", async () => {
    const withoutEndpoints = makeMutatedServiceType((plan) => ({ ...plan, endpoints: [] }));
    await expectServiceContractFailure(withoutEndpoints, "service plan emits at least one endpoint");
  });

  test("fails with ContractFailure when emitted endpoint port does not match expected", async () => {
    await expectServiceContractFailure(TestServiceType, "service plan emits expected endpoint ports", {
      expectations: {
        type: "test",
        endpoints: [{ port: 9999, protocol: "tcp" }],
        healthcheck: { kind: "tcp", port: 8080 },
        defaultCredentialEnvKeys: [],
      },
    });
  });

  test("fails with ContractFailure when healthcheck is missing", async () => {
    const withoutHealthcheck = makeMutatedServiceType((plan) => {
      const { healthcheck: _omitted, ...rest } = plan;
      return rest as ServicePlan;
    });
    await expectServiceContractFailure(withoutHealthcheck, "service plan declares a healthcheck");
  });

  test("fails with ContractFailure when healthcheck does not contain the expected probe path", async () => {
    await expectServiceContractFailure(TestServiceType, "service plan healthcheck matches expected probe", {
      expectations: {
        type: "test",
        endpoints: [{ port: 8080, protocol: "tcp" }],
        healthcheck: { kind: "http", path: "/health" },
        defaultCredentialEnvKeys: [],
      },
    });
  });

  test("fails with ContractFailure when TCP command healthcheck only contains the expected port as a substring", async () => {
    await expectServiceContractFailure(TestServiceType, "service plan healthcheck matches expected probe", {
      expectations: {
        type: "test",
        endpoints: [{ port: 8080, protocol: "tcp" }],
        healthcheck: { kind: "tcp", port: 80 },
        defaultCredentialEnvKeys: [],
      },
    });
  });

  test("fails with ContractFailure when HTTP command healthcheck only contains the expected port as a substring", async () => {
    const withHttpCommand = makeMutatedServiceType((plan) => ({
      ...plan,
      healthcheck: {
        kind: "command",
        command: ["sh", "-c", "curl -sf http://localhost:8080/health"],
        intervalSeconds: 10,
        timeoutSeconds: 5,
        retries: 5,
        startPeriodSeconds: 10,
      },
    }));
    await expectServiceContractFailure(withHttpCommand, "service plan healthcheck matches expected probe", {
      expectations: {
        type: "test",
        endpoints: [{ port: 8080, protocol: "tcp" }],
        healthcheck: { kind: "http", port: 80, path: "/health" },
        defaultCredentialEnvKeys: [],
      },
    });
  });

  test("fails with ContractFailure when a required LANDO_* identity key is missing", async () => {
    const withoutLandoEnv = makeMutatedServiceType((plan) => {
      const { LANDO_SERVICE_TYPE: _omitted, ...rest } = plan.environment;
      return { ...plan, environment: rest };
    });
    await expectServiceContractFailure(
      withoutLandoEnv,
      "service plan environment contains the LANDO_* identity keys",
    );
  });

  test("fails with ContractFailure when a declared default-credential env key is missing", async () => {
    await expectServiceContractFailure(
      TestServiceType,
      "service plan environment defines declared default-credential env keys",
      {
        expectations: {
          type: "test",
          endpoints: [{ port: 8080, protocol: "tcp" }],
          healthcheck: { kind: "tcp", port: 8080 },
          defaultCredentialEnvKeys: ["TEST_PASSWORD"],
        },
      },
    );
  });

  test("fails with ContractFailure when default-credential plaintext leaks into command argv", async () => {
    const withLeakedCred = makeMutatedServiceType((plan) => ({
      ...plan,
      command: ["sh", "-c", "echo lando-secret-leak | tee /dev/null"],
      environment: { ...plan.environment, TEST_PASSWORD: "lando-secret-leak" },
    }));
    const result = await Effect.runPromiseExit(
      runServiceContract({
        serviceType: withLeakedCred,
        landofileService: { type: "test" },
        providerId: ProviderId.make("test"),
        providerCapabilities: TEST_PROVIDER_CAPABILITIES,
        platform: "linux",
        expectations: {
          type: "test",
          endpoints: [{ port: 8080, protocol: "tcp" }],
          healthcheck: { kind: "tcp", port: 8080 },
          defaultCredentialEnvKeys: ["TEST_PASSWORD"],
          defaultCredentialSecretEnvKeys: ["TEST_PASSWORD"],
        },
      }),
    );

    expect(result._tag).toBe("Failure");
    if (result._tag !== "Failure") return;
    expect(result.cause._tag).toBe("Fail");
    if (result.cause._tag !== "Fail") return;
    expect(result.cause.error.assertion).toBe(
      "service plan default-credential values are not leaked into argv",
    );
    expect(JSON.stringify(result.cause.error.details)).not.toContain("lando-secret-leak");
    expect(JSON.stringify(result.cause.error.details)).toContain("[REDACTED]");
  });
});

describe("runServiceContractMatrix", () => {
  test("is exported as an Effect-returning matrix runner", () => {
    expect(typeof runServiceContractMatrix).toBe("function");
  });

  test("runs supported cells and reports skipped cells with reason", async () => {
    const report = await Effect.runPromise(
      runServiceContractMatrix({
        serviceTypeId: "test",
        cells: [
          {
            providerId: ProviderId.make("test"),
            platform: "linux",
            supported: true,
            factory: () => ({
              serviceType: TestServiceType,
              landofileService: { type: "test" },
              providerId: ProviderId.make("test"),
              providerCapabilities: TEST_PROVIDER_CAPABILITIES,
              platform: "linux",
              expectations: {
                type: "test",
                endpoints: [{ port: 8080, protocol: "tcp" }],
                healthcheck: { kind: "tcp", port: 8080 },
                defaultCredentialEnvKeys: [],
              },
            }),
          },
          {
            providerId: ProviderId.make("test"),
            platform: "darwin",
            supported: false,
            skipReason: "not supported on darwin in this fixture",
          },
          {
            providerId: ProviderId.make("test"),
            platform: "win32",
            supported: false,
            skipReason: "not supported on win32 in this fixture",
          },
          {
            providerId: ProviderId.make("test"),
            platform: "wsl",
            supported: false,
            skipReason: "not supported on wsl in this fixture",
          },
        ],
      }),
    );

    expect(report.serviceTypeId).toBe("test");
    expect(report.results).toHaveLength(4);
    expect(report.results[0]).toMatchObject({ providerId: "test", platform: "linux", outcome: "passed" });
    expect(report.results[1]).toMatchObject({
      providerId: "test",
      platform: "darwin",
      outcome: "skipped",
      reason: "not supported on darwin in this fixture",
    });
  });

  test("requires every canonical host platform to be declared per provider", async () => {
    const exit = await Effect.runPromiseExit(
      runServiceContractMatrix({
        serviceTypeId: "test",
        cells: [
          {
            providerId: ProviderId.make("test"),
            platform: "linux",
            supported: true,
            factory: () => ({
              serviceType: TestServiceType,
              landofileService: { type: "test" },
              providerId: ProviderId.make("test"),
              providerCapabilities: TEST_PROVIDER_CAPABILITIES,
              platform: "linux",
              expectations: {
                type: "test",
                endpoints: [{ port: 8080, protocol: "tcp" }],
                healthcheck: { kind: "tcp", port: 8080 },
                defaultCredentialEnvKeys: [],
              },
            }),
          },
          { providerId: ProviderId.make("test"), platform: "darwin", supported: false, skipReason: "n/a" },
          { providerId: ProviderId.make("test"), platform: "win32", supported: false, skipReason: "n/a" },
        ],
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error).toBeInstanceOf(ContractFailure);
    expect(exit.cause.error.assertion).toBe(
      "service contract matrix declares every canonical host platform per provider",
    );
  });

  test("requires supported factory provider and platform to match the cell", async () => {
    const exit = await Effect.runPromiseExit(
      runServiceContractMatrix({
        serviceTypeId: "test",
        cells: [
          {
            providerId: ProviderId.make("test"),
            platform: "linux",
            supported: true,
            factory: () => ({
              serviceType: TestServiceType,
              landofileService: { type: "test" },
              providerId: ProviderId.make("test"),
              providerCapabilities: TEST_PROVIDER_CAPABILITIES,
              platform: "darwin",
              expectations: {
                type: "test",
                endpoints: [{ port: 8080, protocol: "tcp" }],
                healthcheck: { kind: "tcp", port: 8080 },
                defaultCredentialEnvKeys: [],
              },
            }),
          },
          { providerId: ProviderId.make("test"), platform: "darwin", supported: false, skipReason: "n/a" },
          { providerId: ProviderId.make("test"), platform: "win32", supported: false, skipReason: "n/a" },
          { providerId: ProviderId.make("test"), platform: "wsl", supported: false, skipReason: "n/a" },
        ],
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error.assertion).toBe("service contract matrix factory platform matches cell platform");
  });

  test("requires an unsupported cell to provide a skip reason", async () => {
    const exit = await Effect.runPromiseExit(
      runServiceContractMatrix({
        serviceTypeId: "test",
        cells: [
          {
            providerId: ProviderId.make("test"),
            platform: "linux",
            supported: true,
            factory: () => ({
              serviceType: TestServiceType,
              landofileService: { type: "test" },
              providerId: ProviderId.make("test"),
              providerCapabilities: TEST_PROVIDER_CAPABILITIES,
              platform: "linux",
              expectations: {
                type: "test",
                endpoints: [{ port: 8080, protocol: "tcp" }],
                healthcheck: { kind: "tcp", port: 8080 },
                defaultCredentialEnvKeys: [],
              },
            }),
          },
          {
            providerId: ProviderId.make("test"),
            platform: "darwin",
            supported: false,
          } as unknown as Parameters<typeof runServiceContractMatrix>[0]["cells"][number],
          { providerId: ProviderId.make("test"), platform: "win32", supported: false, skipReason: "n/a" },
          { providerId: ProviderId.make("test"), platform: "wsl", supported: false, skipReason: "n/a" },
        ],
      }),
    );

    expect(exit._tag).toBe("Failure");
    if (exit._tag !== "Failure") return;
    expect(exit.cause._tag).toBe("Fail");
    if (exit.cause._tag !== "Fail") return;
    expect(exit.cause.error).toBeInstanceOf(ContractFailure);
    expect(exit.cause.error.assertion).toBe(
      "unsupported service contract matrix cell declares a skip reason",
    );
  });
});

const makeMutatedServiceType = (
  mutate: (plan: ServicePlan) => ServicePlan | Record<string, unknown>,
): ServiceTypeShape => ({
  id: "test",
  toServicePlan: (input: ServiceTypePlanInput) => {
    const original = TestServiceType.toServicePlan(input);
    return mutate(original) as ServicePlan;
  },
});

void Schema;
void ServiceName;
