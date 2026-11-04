import { describe, expect, test } from "bun:test";
import { Cause, Effect } from "effect";

import { PortablePath } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition, ServiceMountIntent } from "@lando/sdk/services";
import {
  ContractFailure,
  type ServiceFeatureContractHarness,
  runServiceFeatureContract,
} from "@lando/sdk/test";

const expectFeatureFailure = async (
  feature: ServiceFeatureDefinition,
  assertion: string,
  input: Omit<ServiceFeatureContractHarness, "feature"> = {},
): Promise<void> => {
  const result = await Effect.runPromiseExit(runServiceFeatureContract({ ...input, feature }));

  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") return;
  expect(result.cause.reasons).toHaveLength(1);
  const reason = result.cause.reasons[0];
  if (reason === undefined) throw new Error("expected a failure reason");
  expect(Cause.isFailReason(reason)).toBe(true);
  if (!Cause.isFailReason(reason)) return;
  expect(reason.error).toBeInstanceOf(ContractFailure);
  expect(reason.error._tag).toBe("ContractFailure");
  expect(reason.error.assertion).toBe(assertion);
};

describe("runServiceFeatureContract", () => {
  test.each(["config", "normalizedConfig", "connection", "appRoot"] as const)(
    "rejects declaration mutation of %s",
    async (field) => {
      // Given
      const feature: ServiceFeatureDefinition = {
        id: "mutated-declaration-facts",
        priority: 100,
        declareEndpoints: (ctx) =>
          Effect.sync(() => {
            switch (field) {
              case "config":
                Reflect.set(ctx.config, "port", 9000);
                break;
              case "normalizedConfig":
                Reflect.set(ctx.normalizedConfig, "port", 9000);
                break;
              case "connection":
                if (ctx.connection === undefined) throw new Error("Missing fixture connection");
                Reflect.set(ctx.connection.creds, "user", "changed");
                break;
              case "appRoot":
                Reflect.set(ctx, "appRoot", "/changed");
                break;
              default:
                field satisfies never;
            }
            return [];
          }),
        apply: () => Effect.void,
      };
      // When / Then
      await expectFeatureFailure(feature, "service feature endpoint declaration facts are immutable", {
        connection: {
          family: "postgres",
          port: 5432,
          creds: { user: "app", password: "secret", database: "app" },
        },
      });
    },
  );

  test.each([0, 65536])("rejects schema-invalid declared endpoint port %s", async (port) => {
    // Given
    const feature: ServiceFeatureDefinition = {
      id: "malformed-declaration",
      priority: 100,
      declareEndpoints: () => Effect.succeed([{ _tag: "internal", protocol: "http", port }]),
      apply: () => Effect.void,
    };
    // When / Then
    await expectFeatureFailure(feature, "service feature endpoint declarations match EndpointPlan");
  });

  test.each(["throw", "defect"] as const)("reports a declaration %s as ContractFailure", async (failure) => {
    // Given
    const feature: ServiceFeatureDefinition = {
      id: "failed-declaration",
      priority: 100,
      declareEndpoints: () => {
        if (failure === "throw") throw new Error("Declaration fixture failure");
        return Effect.die("Declaration fixture defect");
      },
      apply: () => Effect.void,
    };
    // When / Then
    await expectFeatureFailure(feature, "endpoint declaration succeeds");
  });
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

  test("fails when a feature emits non-deterministic extensions", async () => {
    const feature: ServiceFeatureDefinition = {
      id: "non-deterministic-extension",
      priority: 35,
      apply: (ctx) =>
        Effect.sync(() => {
          ctx.addExtension("random", Math.random());
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
        }),
    };

    await expectFeatureFailure(feature, "feature emits storage intent without realization decisions");
  });

  test("fails when a feature leaks an endpoint realization decision", async () => {
    const feature: ServiceFeatureDefinition = {
      id: "realization-leak-endpoint",
      priority: 45,
      declareEndpoints: () =>
        Effect.succeed([
          {
            _tag: "internal" as const,
            name: "web",
            port: 8080,
            protocol: "tcp" as const,
            realization: "host",
          },
        ]),
      apply: () => Effect.void,
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
