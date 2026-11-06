import { expect, test } from "bun:test";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Schema } from "effect";
import { emptyGlobalPolicy } from "../../src/global-app/enablement.ts";
import {
  GlobalContributionStateSchema,
  projectEffectiveGlobalResolution,
  resolveGlobalServices,
} from "../../src/services/global-services.ts";

test.each([
  { enabled: false, state: "disabled", valid: true },
  { enabled: false, state: "enabled", valid: false },
  { enabled: false, state: "blocked", valid: false },
  { enabled: false, state: "unverified", valid: false },
  { enabled: true, state: "disabled", valid: false },
  { enabled: true, state: "enabled", valid: true },
  { enabled: true, state: "blocked", valid: true },
  { enabled: true, state: "unverified", valid: true },
])("global contribution policy/admission contract: %j", ({ enabled, state, valid }) => {
  expect(
    Schema.is(GlobalContributionStateSchema)({
      id: "router",
      plugin: "example",
      enabled,
      state,
      source: "default",
      capabilitySource: "unavailable",
      reasons: [],
      requiredServices: [],
      dependencyEvidence: "unavailable",
      commands: [],
    }),
  ).toBe(valid);
});

test.each([undefined, { ...TestRuntimeProvider.capabilities, sharedCrossAppNetwork: false }])(
  "disabled contributions keep policy precedence through capability, conflict and graph resolution: %j",
  async (providerCapabilities) => {
    const resolution = await Effect.runPromise(
      resolveGlobalServices({
        contributions: [
          {
            plugin: "example",
            contribution: {
              id: "disabled",
              enabledByDefault: false,
              conflicts: ["consumer"],
              requires: { providerCapabilities: ["sharedCrossAppNetwork"] },
            },
          },
          { plugin: "example", contribution: { id: "consumer", conflicts: ["disabled"] } },
        ],
        policy: emptyGlobalPolicy(),
        providerId: "test",
        ...(providerCapabilities === undefined ? {} : { providerCapabilities }),
        loadServiceConfig: (entry) =>
          entry.contribution.id === "disabled"
            ? Effect.die("disabled module evaluated")
            : Effect.succeed({ type: "compose", dependsOn: [{ service: "disabled" }] }),
      }),
    );

    const projected = projectEffectiveGlobalResolution(resolution, {
      ...resolution.composableServices,
      disabled: { type: "compose", dependsOn: [{ service: "consumer" }] },
    });

    for (const result of [resolution, projected]) {
      expect(result.entries.find((row) => row.id === "disabled")).toMatchObject({
        enabled: false,
        state: "disabled",
        reasons: ["policy-disabled"],
      });
      expect(result.entries.find((row) => row.id === "consumer")).toMatchObject({
        enabled: true,
        state: "blocked",
        reasons: ["dependency-unavailable:disabled"],
      });
      expect(result.entries.every(Schema.is(GlobalContributionStateSchema))).toBe(true);
    }
  },
);
