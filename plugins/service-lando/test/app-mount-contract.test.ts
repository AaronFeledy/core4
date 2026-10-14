import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { type ServiceFeatureContractHarness, runServiceFeatureContract } from "@lando/sdk/test";

import { landoAppMountFeature } from "../src/features/app-mount.ts";
import { serviceTypes } from "../src/index.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

describe("lando.app-mount service-feature contract", () => {
  test.each([
    {},
    { config: { target: "/app" } },
    { config: { target: "/app", readOnly: true, excludes: ["vendor"], workingDirectory: "/app/web" } },
    {
      config: { target: "/app" },
      normalizedConfig: {
        appMount: false,
        mounts: ["./config:/etc/service:ro", { type: "tmpfs", target: "/scratch" }],
      },
    },
    {
      config: { target: "/app" },
      normalizedConfig: { appMount: { target: "/site" }, mounts: ["./alternate:/site/./"] },
    },
  ] satisfies readonly Omit<ServiceFeatureContractHarness, "feature">[])(
    "emits provider-neutral intent for configured inputs %j",
    async (input) => {
      // Given
      const harness = { feature: landoAppMountFeature, ...input };
      // When
      const result = await Effect.runPromise(runServiceFeatureContract(harness));
      // Then
      expect(result).toBeUndefined();
    },
  );

  test.each(["apache", "php:8.3"])("finalization retains passthrough app mounts for %s", async (type) => {
    // Given
    const serviceType = serviceTypes.get(type);
    if (serviceType === undefined) throw new Error(`Missing service type ${type}`);
    // When
    const plan = await composeServicePlan({
      serviceType,
      service: { type },
      appRoot: "/srv/project",
      appName: "contract-check",
      metadata: { resolvedAt: "2026-01-01T00:00:00Z", source: "/srv/project/.lando.yml", runtime: 4 },
    });
    // Then
    expect(plan.appMount?.realization).toBe("passthrough");
  });
});
