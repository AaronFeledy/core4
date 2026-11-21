import { describe, expect, test } from "bun:test";
import { buildProviderCapabilities } from "@lando/container-runtime/capabilities";
import type { LandofileShape, ProviderCapabilities } from "@lando/sdk/schema";
import { ServiceName } from "@lando/sdk/schema";

import {
  APP_PLAN_CACHE_SCHEMA_VERSION,
  type AppPlanCacheKeyInput,
  deriveAppPlanCacheKey,
} from "../../src/cache/app-plan.ts";

const capabilities = (overrides: Partial<ProviderCapabilities> = {}): ProviderCapabilities => ({
  ...buildProviderCapabilities({
    bindMounts: true,
    bindMountPerformance: "native",
    tlsCertificates: "lando",
    rootless: true,
    composeSpec: "native",
    providerExtensions: [],
  }),
  ...overrides,
});

const base = (overrides: Partial<AppPlanCacheKeyInput> = {}): AppPlanCacheKeyInput => ({
  hostProvider: "lando",
  appRoot: "/tmp/project-user-app",
  landofile: {
    name: "project-user-app",
    services: { [ServiceName.make("web")]: { type: "php:8.3" } },
  } as LandofileShape,
  providerCapabilities: capabilities({
    projectUserMapping: "userns-keep-id",
    bindOwnership: "root-is-host-user",
  }),
  pluginManifests: [],
  ...overrides,
});

describe("deriveAppPlanCacheKey project-user facts", () => {
  test("bumps the schema version for the new plan fields", () => {
    expect(APP_PLAN_CACHE_SCHEMA_VERSION).toBe(65n);
  });

  test("mapping support changes the key", () => {
    const supported = deriveAppPlanCacheKey(base());
    const unsupported = deriveAppPlanCacheKey(
      base({
        providerCapabilities: capabilities({
          projectUserMapping: "unsupported",
          bindOwnership: "root-is-host-user",
        }),
      }),
    );
    expect(supported).not.toBe(unsupported);
  });

  test("bind ownership changes the key", () => {
    const mapped = deriveAppPlanCacheKey(base());
    const hostsIds = deriveAppPlanCacheKey(
      base({
        providerCapabilities: capabilities({
          projectUserMapping: "userns-keep-id",
          bindOwnership: "host-ids",
        }),
      }),
    );
    expect(mapped).not.toBe(hostsIds);
  });

  test.each(["uid", "gid"] as const)("host %s changes the key only when the engine renumbers to it", (id) => {
    const renumbered = capabilities({
      projectUserMapping: "image-renumber",
      bindOwnership: "host-ids",
    });
    const first = deriveAppPlanCacheKey(
      base({
        providerCapabilities: renumbered,
        host: { uid: "1000", gid: "1000" },
      }),
    );
    const second = deriveAppPlanCacheKey(
      base({
        providerCapabilities: renumbered,
        host: { uid: "1000", gid: "1000", [id]: "1001" },
      }),
    );
    expect(first).not.toBe(second);

    const keepId = base({
      providerCapabilities: capabilities({
        projectUserMapping: "userns-keep-id",
        bindOwnership: "root-is-host-user",
      }),
    });
    expect(deriveAppPlanCacheKey({ ...keepId, host: { uid: "1000", gid: "1000" } })).toBe(
      deriveAppPlanCacheKey({ ...keepId, host: { uid: "1000", gid: "1000", [id]: "1001" } }),
    );
  });

  test("capabilities that differ elsewhere do not change the key", () => {
    const first = deriveAppPlanCacheKey(base());
    const second = deriveAppPlanCacheKey(
      base({
        providerCapabilities: capabilities({
          projectUserMapping: "userns-keep-id",
          bindOwnership: "root-is-host-user",
          bindMounts: false,
        }),
      }),
    );
    expect(second).toBe(first);
  });
});
