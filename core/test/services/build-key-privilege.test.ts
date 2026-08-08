import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { ProviderId, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { buildKeyForService } from "@lando/engine/services/build-key";

const providerId = ProviderId.make("test");
const provider = { ...TestRuntimeProvider, id: providerId, version: "1.0.0", platform: "linux" as const };

const serviceWithPrivilege = (privileged?: boolean): ServicePlan => ({
  name: ServiceName.make("web"),
  type: "node",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "debian:12" },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-08-01T00:00:00.000Z"),
    source: "build-key-privilege.test",
    runtime: 4,
  },
  extensions: {
    "@lando/core/service-features": {
      buildSteps: [
        {
          id: "scaffold",
          phase: "build",
          command: "mkdir -p /etc/lando",
          ...(privileged === undefined ? {} : { privileged }),
        },
      ],
    },
  },
});

const keyForPrivilege = (privileged?: boolean): Promise<string> =>
  Effect.runPromise(buildKeyForService(provider, serviceWithPrivilege(privileged)));

describe("build step privilege identity", () => {
  test("changes the artifact build key when privilege changes", async () => {
    // Given / When
    const privileged = await keyForPrivilege(true);
    const unprivileged = await keyForPrivilege(false);

    // Then
    expect(privileged).not.toBe(unprivileged);
  });

  test("keeps repeated identical privilege inputs stable", async () => {
    // Given / When
    const first = await keyForPrivilege(true);
    const repeated = await keyForPrivilege(true);

    // Then
    expect(repeated).toBe(first);
  });

  test("treats omitted privilege the same as explicit false", async () => {
    // Given / When
    const omitted = await keyForPrivilege(undefined);
    const explicitFalse = await keyForPrivilege(false);

    // Then
    expect(omitted).toBe(explicitFalse);
  });
});
