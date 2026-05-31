import { describe, expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { dockerCapabilitiesForPlatform } from "@lando/provider-docker";
import { providerLandoCapabilitiesForPlatform } from "@lando/provider-lando";
import { podmanCapabilitiesForPlatform } from "@lando/provider-podman";
import { GlobalServiceCapabilityError } from "@lando/sdk/errors";
import {
  type AppPlan,
  LANDO_SHARED_CROSS_APP_NETWORK,
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
  copyOnWriteAppRoot: false,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
  ...overrides,
});

const planApp = (
  landofileInput: Record<string, unknown>,
  capabilities: ProviderCapabilities,
): Promise<AppPlan> => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)(landofileInput);
  return Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities)).pipe(
      Effect.provide(AppPlannerLive),
      Effect.provide(PluginRegistryLive),
    ),
  );
};

const planUserApp = (capabilities: ProviderCapabilities): Promise<AppPlan> =>
  planApp({ name: "shop", services: { web: { image: "nginx:1.27", port: 80 } } }, capabilities);

const canReachSharedAlias = (source: AppPlan, targets: ReadonlyArray<AppPlan>, alias: string): boolean => {
  const sourceNetwork = source.networking?.sharedNetworkMembership?.name;
  if (sourceNetwork === undefined) return false;

  return targets.some((target) => {
    const targetMembership = target.networking?.sharedNetworkMembership;
    if (targetMembership?.name !== sourceNetwork) return false;

    return Object.values(targetMembership.aliases).some((aliases) => aliases.includes(alias));
  });
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

describe("per-app NetworkingPlan + cross-app reachability (US-109)", () => {
  test("emits a per-app bridge plus shared cross-app membership for a service app", async () => {
    const plan = await planUserApp(baseCapabilities({ sharedCrossAppNetwork: true }));
    expect(plan.networking?.perAppBridge.name).toBe("lando-shop");
    expect(plan.networking?.sharedNetworkMembership?.name).toBe(LANDO_SHARED_CROSS_APP_NETWORK);
    expect(plan.networking?.sharedNetworkMembership?.aliases[ServiceName.make("web")]).toEqual([
      "web.shop.internal",
    ]);
  });

  test("omits shared membership for a provider without sharedCrossAppNetwork", async () => {
    const plan = await planUserApp(baseCapabilities({ sharedCrossAppNetwork: false }));
    expect(plan.networking?.perAppBridge.name).toBe("lando-shop");
    expect(plan.networking?.sharedNetworkMembership).toBeUndefined();
  });

  test("two apps and the global Traefik proxy all join the shared network and resolve each other", async () => {
    const capabilities = baseCapabilities({ sharedCrossAppNetwork: true });
    const [shop, blog, global] = await Promise.all([
      planApp({ name: "shop", services: { web: { image: "nginx:1.27", port: 80 } } }, capabilities),
      planApp({ name: "blog", services: { web: { image: "nginx:1.27", port: 80 } } }, capabilities),
      planApp(
        { name: "lando-global", services: { traefik: { image: "nginx:1.27", port: 80 } } },
        capabilities,
      ),
    ]);

    for (const plan of [shop, blog, global]) {
      expect(plan.networking?.sharedNetworkMembership?.name).toBe(LANDO_SHARED_CROSS_APP_NETWORK);
    }

    expect(shop.networking?.sharedNetworkMembership?.aliases[ServiceName.make("web")]).toEqual([
      "web.shop.internal",
    ]);
    expect(blog.networking?.sharedNetworkMembership?.aliases[ServiceName.make("web")]).toEqual([
      "web.blog.internal",
    ]);
    expect(global.networking?.sharedNetworkMembership?.aliases[ServiceName.make("traefik")]).toEqual([
      "traefik.lando-global.internal",
    ]);

    const perAppBridges = [shop, blog, global].map((plan) => plan.networking?.perAppBridge.name);
    expect(new Set(perAppBridges).size).toBe(3);
    expect(perAppBridges).toEqual(["lando-shop", "lando-blog", "lando-lando-global"]);

    const sharedNames = new Set(
      [shop, blog, global].map((plan) => plan.networking?.sharedNetworkMembership?.name),
    );
    expect(sharedNames).toEqual(new Set([LANDO_SHARED_CROSS_APP_NETWORK]));

    expect(canReachSharedAlias(global, [shop, blog], "web.shop.internal")).toBe(true);
    expect(canReachSharedAlias(global, [shop, blog], "web.blog.internal")).toBe(true);
    expect(canReachSharedAlias(shop, [global], "traefik.lando-global.internal")).toBe(true);
    expect(canReachSharedAlias(blog, [global], "traefik.lando-global.internal")).toBe(true);
    expect(canReachSharedAlias(shop, [blog], "web.blog.internal")).toBe(true);
  });
});
