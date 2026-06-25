import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { PortablePath } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition, ServiceMountIntent } from "@lando/sdk/services";
import { ContractFailure, runServiceFeatureContract } from "@lando/sdk/test";

const expectFeatureFailure = async (feature: ServiceFeatureDefinition, assertion: string): Promise<void> => {
  const result = await Effect.runPromiseExit(runServiceFeatureContract({ feature }));

  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(result.cause._tag).toBe("Fail");
  if (result.cause._tag !== "Fail") return;
  expect(result.cause.error).toBeInstanceOf(ContractFailure);
  expect(result.cause.error._tag).toBe("ContractFailure");
  expect(result.cause.error.assertion).toBe(assertion);
};

describe("runServiceFeatureContract", () => {
  test("passes for a feature that emits provider-neutral intent only", async () => {
    const feature: ServiceFeatureDefinition = {
      id: "intent-only",
      priority: 10,
      apply: (ctx) =>
        Effect.sync(() => {
          ctx.addEnv("LANDO_FEATURE", "enabled");
          ctx.addMount({ type: "bind", source: "/host", target: PortablePath.make("/app"), readOnly: false });
          ctx.addBuildStep({ phase: "build", command: "echo building" });
        }),
    };

    const result = await Effect.runPromiseExit(runServiceFeatureContract({ feature }));

    expect(result._tag).toBe("Success");
  });

  test("fails when a feature leaks a mount realization decision", async () => {
    const feature: ServiceFeatureDefinition = {
      id: "realization-leak",
      priority: 20,
      apply: (ctx) =>
        Effect.sync(() => {
          const mount = {
            type: "bind",
            source: "/host",
            target: "/app",
            readOnly: false,
            realization: "accelerated",
          } as unknown as ServiceMountIntent;
          ctx.addMount(mount);
        }),
    };

    await expectFeatureFailure(feature, "feature emits mount intent without realization decisions");
  });

  test("fails when a feature emits non-deterministic draft intent", async () => {
    const feature: ServiceFeatureDefinition = {
      id: "non-deterministic",
      priority: 30,
      apply: (ctx) =>
        Effect.sync(() => {
          ctx.addEnv("RANDOM_VALUE", String(Math.random()));
        }),
    };

    await expectFeatureFailure(feature, "service feature apply is deterministic/idempotent");
  });

  test("fails when a feature leaks storage or endpoint realization decisions", async () => {
    const feature: ServiceFeatureDefinition = {
      id: "realization-leak-storage-endpoint",
      priority: 40,
      apply: (ctx) =>
        Effect.sync(() => {
          ctx.addStorage({ name: "db", target: "/data", realization: "volume" } as unknown as Parameters<
            typeof ctx.addStorage
          >[0]);
          ctx.addEndpoint({
            name: "web",
            port: 8080,
            protocol: "tcp",
            realization: "host",
          } as unknown as Parameters<typeof ctx.addEndpoint>[0]);
        }),
    };

    await expectFeatureFailure(feature, "feature emits storage intent without realization decisions");
  });

  test("fails when a feature leaks an endpoint realization decision", async () => {
    const feature: ServiceFeatureDefinition = {
      id: "realization-leak-endpoint",
      priority: 45,
      apply: (ctx) =>
        Effect.sync(() => {
          ctx.addEndpoint({
            name: "web",
            port: 8080,
            protocol: "tcp",
            realization: "host",
          } as unknown as Parameters<typeof ctx.addEndpoint>[0]);
        }),
    };

    await expectFeatureFailure(feature, "feature emits endpoint intent without realization decisions");
  });

  test("fails when a feature declares malformed requires capabilities", async () => {
    const feature = {
      id: "malformed-requires",
      priority: 50,
      requires: [""],
      apply: () => Effect.void,
    } as unknown as ServiceFeatureDefinition;

    await expectFeatureFailure(
      feature,
      "service feature requires is an array of non-empty capability strings",
    );
  });
});
