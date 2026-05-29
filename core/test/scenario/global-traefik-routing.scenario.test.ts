import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { dockerCapabilitiesForPlatform } from "@lando/provider-docker";
import { providerLandoCapabilitiesForPlatform } from "@lando/provider-lando";
import { podmanCapabilitiesForPlatform } from "@lando/provider-podman";
import { GlobalServiceCapabilityError } from "@lando/sdk/errors";
import {
  type AppPlan,
  LandofileShape,
  PluginManifest,
  type ProviderCapabilities,
  ServiceName,
} from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";

import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { validateGlobalServiceContributions } from "../../src/services/global-services.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

const traefikGlobalManifest = Schema.decodeSync(PluginManifest)({
  name: "@lando/proxy-traefik",
  version: "0.0.0",
  api: 4,
  description: "Routes user-app HTTP services through the global Traefik proxy.",
  contributes: {
    proxies: ["traefik"],
    globalServices: [
      {
        id: "traefik",
        module: "./src/global-services/traefik.ts",
        enabledByDefault: true,
        requires: { providerCapabilities: ["sharedCrossAppNetwork"] },
        summary: "Global Traefik reverse proxy",
      },
    ],
  },
});

const baseCapabilities = (overrides: Partial<ProviderCapabilities>): ProviderCapabilities => ({
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
  copyMounts: false,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
  ...overrides,
});

const planUserApp = (capabilities: ProviderCapabilities): Promise<AppPlan> => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "shop",
    services: { web: { image: "nginx:1.27", port: 80 } },
  });
  return Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities)).pipe(
      Effect.provide(AppPlannerLive),
      Effect.provide(PluginRegistryLive),
    ),
  );
};

describe("sharedCrossAppNetwork capability and provider-side wiring", () => {
  test("providers advertise sharedCrossAppNetwork on every supported platform", () => {
    for (const platform of ["linux", "darwin", "win32"] as const) {
      expect(providerLandoCapabilitiesForPlatform(platform).sharedCrossAppNetwork).toBe(true);
      expect(dockerCapabilitiesForPlatform(platform).sharedCrossAppNetwork).toBe(true);
      expect(podmanCapabilitiesForPlatform(platform).sharedCrossAppNetwork).toBe(true);
    }
  });

  test("accepts the global Traefik contribution when the provider advertises sharedCrossAppNetwork", () => {
    const result = validateGlobalServiceContributions({
      manifests: [traefikGlobalManifest],
      providerCapabilities: baseCapabilities({ sharedCrossAppNetwork: true }),
      providerId: "docker",
    });

    expect(result.rejected).toHaveLength(0);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.contribution.id).toBe("traefik");
    expect(result.accepted[0]?.plugin).toBe("@lando/proxy-traefik");
  });

  test("rejects the global Traefik contribution with a GlobalServiceCapabilityError when sharedCrossAppNetwork is false", () => {
    const result = validateGlobalServiceContributions({
      manifests: [traefikGlobalManifest],
      providerCapabilities: baseCapabilities({ sharedCrossAppNetwork: false }),
      providerId: "stub-no-network",
    });

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);

    const error = result.rejected[0];
    expect(error).toBeInstanceOf(GlobalServiceCapabilityError);
    if (error === undefined) throw new Error("expected at least one rejection");
    expect(error.id).toBe("traefik");
    expect(error.plugin).toBe("@lando/proxy-traefik");
    expect(error.providerId).toBe("stub-no-network");
    expect([...error.missing]).toEqual(["sharedCrossAppNetwork"]);
    expect(error.remediation).toContain("sharedCrossAppNetwork");
    expect(error.remediation).toContain("provider");
  });

  test("a per-app web service plan on a sharedCrossAppNetwork-capable provider exposes the route Traefik routes through", async () => {
    const plan = await planUserApp(baseCapabilities({ sharedCrossAppNetwork: true }));
    const web = plan.services[ServiceName.make("web")];
    if (web === undefined) throw new Error("web service missing from plan");

    expect(plan.routes.some((route) => route.hostname === "web.shop.lndo.site")).toBe(true);
    expect(plan.networks.length).toBeGreaterThan(0);
    expect(plan.networks[0]?.name).toBe("lando-shop");

    const validation = validateGlobalServiceContributions({
      manifests: [traefikGlobalManifest],
      providerCapabilities: baseCapabilities({ sharedCrossAppNetwork: true }),
      providerId: "docker",
    });
    expect(validation.accepted.map((entry) => entry.contribution.id)).toEqual(["traefik"]);
  });

  test("a contribution without provider-capability requirements is always accepted", () => {
    const manifest = Schema.decodeSync(PluginManifest)({
      name: "@lando/cert-mkcert",
      version: "0.0.0",
      api: 4,
      contributes: {
        globalServices: [
          {
            id: "mkcert-ca",
            module: "./src/global-services/mkcert.ts",
            enabledByDefault: true,
            summary: "Local CA install runner",
          },
        ],
      },
    });

    const result = validateGlobalServiceContributions({
      manifests: [manifest],
      providerCapabilities: baseCapabilities({ sharedCrossAppNetwork: false }),
      providerId: "lando",
    });

    expect(result.rejected).toHaveLength(0);
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0]?.contribution.id).toBe("mkcert-ca");
  });

  test("rejection enumerates every missing capability per contribution", () => {
    const manifest = Schema.decodeSync(PluginManifest)({
      name: "@lando/proxy-experimental",
      version: "0.0.0",
      api: 4,
      contributes: {
        globalServices: [
          {
            id: "experimental",
            module: "./src/global-services/experimental.ts",
            requires: {
              providerCapabilities: ["sharedCrossAppNetwork", "routeProvider"],
            },
            summary: "Hypothetical route-provider proxy",
          },
        ],
      },
    });

    const result = validateGlobalServiceContributions({
      manifests: [manifest],
      providerCapabilities: baseCapabilities({
        sharedCrossAppNetwork: false,
        routeProvider: false,
      }),
      providerId: "lando",
    });

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toHaveLength(1);

    const error = result.rejected[0];
    if (error === undefined) throw new Error("expected at least one rejection");
    expect([...error.missing].sort()).toEqual(["routeProvider", "sharedCrossAppNetwork"]);
  });
});
