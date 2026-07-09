import { describe, expect, test } from "bun:test";

import { Effect, Schema } from "effect";

import { ServiceTypeError } from "@lando/sdk/errors";
import { AbsolutePath, LogSourceId, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import type { ServiceType, ServiceTypeInput, ServiceTypeResolution } from "@lando/sdk/services";
import {
  ContractFailure,
  type ServiceCompositionContractInput,
  TestServiceType,
  runServiceCompositionContract,
} from "@lando/sdk/test";

const baseInput = (
  overrides?: Partial<ServiceCompositionContractInput>,
): ServiceCompositionContractInput => ({
  serviceType: TestServiceType,
  landofileService: { type: "test" },
  providerId: ProviderId.make("test"),
  ...overrides,
});

const expectCompositionFailure = async (
  serviceType: ServiceType,
  assertion: string,
  overrides?: Partial<ServiceCompositionContractInput>,
): Promise<void> => {
  const result = await Effect.runPromiseExit(
    runServiceCompositionContract(baseInput({ serviceType, ...overrides })),
  );

  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(result.cause._tag).toBe("Fail");
  if (result.cause._tag !== "Fail") return;
  expect(result.cause.error).toBeInstanceOf(ContractFailure);
  expect(result.cause.error._tag).toBe("ContractFailure");
  expect(result.cause.error.assertion).toBe(assertion);
};

describe("runServiceCompositionContract", () => {
  test("is exported as an Effect-returning contract helper", () => {
    expect(typeof runServiceCompositionContract).toBe("function");
  });

  test("TestServiceType passes the composition contract suite", async () => {
    const contract = runServiceCompositionContract(baseInput());
    expect(Effect.isEffect(contract)).toBe(true);
    const result = await Effect.runPromise(contract);
    expect(result).toBeUndefined();
  });

  test("fails with ContractFailure when the service type id is empty", async () => {
    await expectCompositionFailure({ ...TestServiceType, id: "" }, "service type exposes a non-empty id");
  });

  test("fails with ContractFailure when the service type name is empty", async () => {
    await expectCompositionFailure({ ...TestServiceType, name: "" }, "service type exposes a non-empty name");
  });

  test("fails with ContractFailure when base is neither l337 nor lando", async () => {
    await expectCompositionFailure(
      { ...TestServiceType, base: "unknown" as ServiceType["base"] },
      "service type declares a base of l337 or lando",
    );
  });

  test("fails with ContractFailure when resolve is not callable", async () => {
    await expectCompositionFailure(
      { ...TestServiceType, resolve: undefined as unknown as ServiceType["resolve"] },
      "service type resolve is callable",
    );
  });

  test("accepts an l337-base service type", async () => {
    const l337Type: ServiceType = {
      ...TestServiceType,
      base: "l337",
      resolve: (input: ServiceTypeInput) =>
        Effect.succeed({ base: "l337", normalizedConfig: input.service, features: [] }),
    };
    const result = await Effect.runPromise(
      runServiceCompositionContract(baseInput({ serviceType: l337Type })),
    );
    expect(result).toBeUndefined();
  });

  test("fails with ContractFailure when the resolved base does not match the service type", async () => {
    const mismatchedBase: ServiceType = {
      ...TestServiceType,
      resolve: (input: ServiceTypeInput) =>
        Effect.succeed({
          base: "l337",
          normalizedConfig: input.service,
          features: [],
        } satisfies ServiceTypeResolution),
    };
    await expectCompositionFailure(mismatchedBase, "resolution base matches the declared service type base");
  });

  test("fails with ContractFailure when resolve returns a hand-built ServicePlan shape", async () => {
    const planLike: ServiceType = {
      ...TestServiceType,
      resolve: (input: ServiceTypeInput) =>
        Effect.succeed(
          Schema.decodeUnknownSync(ServicePlan)({
            name: ServiceName.make(input.name),
            type: "test",
            provider: input.provider ?? ProviderId.make("test"),
            primary: false,
            artifact: { kind: "ref", ref: "alpine:3.20" },
            environment: {},
            mounts: [],
            storage: [],
            endpoints: [{ port: 8080, protocol: "tcp", name: input.name }],
            routes: [],
            dependsOn: [],
            hostAliases: [],
            metadata: input.metadata,
            extensions: {},
          }) as unknown as ServiceTypeResolution,
        ),
    };
    await expectCompositionFailure(planLike, "resolve returns a resolution, not a hand-built ServicePlan");
  });

  test("fails with ContractFailure when a resolved feature declares an empty id", async () => {
    const badFeature: ServiceType = {
      ...TestServiceType,
      resolve: (input: ServiceTypeInput) =>
        Effect.succeed({
          base: "lando",
          normalizedConfig: input.service,
          features: [{ id: "" }],
        } satisfies ServiceTypeResolution),
    };
    await expectCompositionFailure(badFeature, "resolution feature declares a non-empty id");
  });

  test("fails with ContractFailure when a service type declares duplicate log source ids", async () => {
    const badLogSources: ServiceType = {
      ...TestServiceType,
      resolve: (input: ServiceTypeInput) =>
        Effect.succeed({
          base: "lando",
          normalizedConfig: input.service,
          features: [],
          logSources: [
            {
              id: LogSourceId.make("error"),
              path: AbsolutePath.make("/var/log/service/error.log"),
              stream: "stderr",
              strategy: "redirect",
              required: false,
              timestamps: false,
            },
            {
              id: LogSourceId.make("error"),
              path: AbsolutePath.make("/var/log/service/error-2.log"),
              stream: "stderr",
              strategy: "redirect",
              required: false,
              timestamps: false,
            },
          ],
        } satisfies ServiceTypeResolution),
    };
    await expectCompositionFailure(badLogSources, "resolution logSource ids are unique within the service");
  });

  test("fails with ContractFailure when a l337 service type declares redirect log sources", async () => {
    const badStrategy: ServiceType = {
      ...TestServiceType,
      base: "l337",
      resolve: (input: ServiceTypeInput) =>
        Effect.succeed({
          base: "l337",
          normalizedConfig: input.service,
          features: [],
          logSources: [
            {
              id: LogSourceId.make("error"),
              path: AbsolutePath.make("/var/log/service/error.log"),
              stream: "stderr",
              strategy: "redirect",
              required: false,
              timestamps: false,
            },
          ],
        } satisfies ServiceTypeResolution),
    };
    await expectCompositionFailure(badStrategy, "resolution logSource strategy is supported by the base");
  });

  test("fails with ContractFailure when resolve fails", async () => {
    const failing: ServiceType = {
      ...TestServiceType,
      resolve: () => Effect.fail(new ServiceTypeError({ message: "boom", serviceType: "test" })),
    };
    await expectCompositionFailure(failing, "service type resolve succeeds");
  });

  test("fails with ContractFailure when the resolved feature list is unstable across replays", async () => {
    let call = 0;
    const unstable: ServiceType = {
      ...TestServiceType,
      resolve: (input: ServiceTypeInput) => {
        call += 1;
        return Effect.succeed({
          base: "lando",
          normalizedConfig: input.service,
          features: call === 1 ? [{ id: "first" }] : [{ id: "second" }],
        } satisfies ServiceTypeResolution);
      },
    };
    await expectCompositionFailure(unstable, "resolution feature list is stable across replays");
  });

  test("fails with ContractFailure when resolved base or normalized config changes across replays", async () => {
    let call = 0;
    const unstableResolution: ServiceType = {
      ...TestServiceType,
      resolve: (input: ServiceTypeInput) => {
        call += 1;
        return Effect.succeed({
          base: call === 1 ? "lando" : "l337",
          normalizedConfig: call === 1 ? input.service : { ...input.service, framework: "second" },
          features: [],
        } satisfies ServiceTypeResolution);
      },
    };
    await expectCompositionFailure(
      unstableResolution,
      "resolution base + normalizedConfig stable across replays",
    );
  });
});

void Schema;
