import { Effect } from "effect";

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
          ctx.addMount({ type: "bind", source: "/host", target: "/app", readOnly: false });
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
});
