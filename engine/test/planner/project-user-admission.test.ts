import { describe, expect, test } from "bun:test";
import { buildProviderCapabilities } from "@lando/container-runtime/capabilities";
import type { ProviderCapabilities } from "@lando/sdk/schema";
import { ProviderId } from "@lando/sdk/schema";

import { projectUserCapabilityErrors } from "../../src/planner/resource-capabilities.ts";

const capabilities = (
  projectUserMapping: ProviderCapabilities["projectUserMapping"],
): ProviderCapabilities => ({
  ...buildProviderCapabilities({
    bindMounts: true,
    bindMountPerformance: "native",
    tlsCertificates: "lando",
    rootless: true,
    composeSpec: "native",
    providerExtensions: [],
  }),
  projectUserMapping,
});

describe("projectUserCapabilityErrors", () => {
  test("a cached plan with a realized mapping fails on a provider that cannot map it", () => {
    const errors = projectUserCapabilityErrors(ProviderId.make("docker"), capabilities("unsupported"), [
      { name: "web", projectUser: { name: "www-data", uid: 33, gid: 33 } },
    ]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.capability).toBe("projectUserMapping");
  });

  test("a cached plan with explicit unsupported authoring fails", () => {
    const errors = projectUserCapabilityErrors(ProviderId.make("docker"), capabilities("unsupported"), [
      {
        name: "web",
        projectUserExplanation: { state: "provider-unsupported", explicit: true },
      },
    ]);
    expect(errors).toHaveLength(1);
  });

  test("an implicit catalog default keeps today's behavior", () => {
    expect(
      projectUserCapabilityErrors(ProviderId.make("docker"), capabilities("unsupported"), [
        { name: "web", projectUserExplanation: { state: "provider-unsupported", explicit: false } },
        { name: "db", projectUserExplanation: { state: "not-applicable", explicit: false } },
      ]),
    ).toEqual([]);
  });

  test("a provider that maps the id admits the plan", () => {
    expect(
      projectUserCapabilityErrors(ProviderId.make("lando"), capabilities("userns-keep-id"), [
        { name: "web", projectUser: { name: "www-data", uid: 33, gid: 33 } },
      ]),
    ).toEqual([]);
  });
});
