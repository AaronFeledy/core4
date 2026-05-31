import { describe, expect, test } from "bun:test";

import { Either, Schema } from "effect";

import {
  LANDO_SHARED_CROSS_APP_NETWORK,
  NetworkingPlan,
  ServiceName,
  landoAppNetworkName,
  landoNetworkNames,
  landoNetworkingPlan,
  landoServiceNetworkAliases,
  landoSharedNetworkName,
} from "@lando/sdk/schema";

describe("NetworkingPlan schema", () => {
  test("decodes a plan with per-app bridge and shared cross-app membership", () => {
    const decoded = Schema.decodeUnknownSync(NetworkingPlan)({
      perAppBridge: { name: "lando-shop", driver: "bridge" },
      sharedNetworkMembership: {
        name: "lando_bridge_network",
        aliases: { web: ["web.shop.internal"] },
      },
    });
    expect(decoded.perAppBridge.name).toBe("lando-shop");
    expect(decoded.sharedNetworkMembership?.name).toBe("lando_bridge_network");
    expect(decoded.sharedNetworkMembership?.aliases[ServiceName.make("web")]).toEqual(["web.shop.internal"]);
  });

  test("decodes a per-app-only plan (no shared membership)", () => {
    const decoded = Schema.decodeUnknownSync(NetworkingPlan)({
      perAppBridge: { name: "lando-shop" },
    });
    expect(decoded.perAppBridge.name).toBe("lando-shop");
    expect(decoded.sharedNetworkMembership).toBeUndefined();
  });

  test("rejects a plan missing the required per-app bridge", () => {
    const result = Schema.decodeUnknownEither(NetworkingPlan)({
      sharedNetworkMembership: { name: "lando_bridge_network", aliases: {} },
    });
    expect(Either.isLeft(result)).toBe(true);
  });
});

describe("landoNetworkingPlan builder", () => {
  test("includes shared cross-app membership when the provider supports it", () => {
    const plan = landoNetworkingPlan({
      slug: "shop",
      serviceNames: ["web", "db"],
      sharedCrossAppNetwork: true,
    });
    expect(plan.perAppBridge).toEqual({ name: "lando-shop", driver: "bridge" });
    expect(plan.sharedNetworkMembership?.name).toBe(LANDO_SHARED_CROSS_APP_NETWORK);
    expect(plan.sharedNetworkMembership?.aliases).toEqual({
      web: ["web.shop.internal"],
      db: ["db.shop.internal"],
    });
  });

  test("adds configured service hostnames to shared cross-app aliases", () => {
    const plan = landoNetworkingPlan({
      slug: "global",
      serviceNames: ["mailpit"],
      sharedCrossAppNetwork: true,
      serviceHostnames: { mailpit: ["mailpit.global.internal", "smtp.global.internal"] },
    });

    expect(plan.sharedNetworkMembership?.aliases).toEqual({
      mailpit: ["mailpit.global.internal", "smtp.global.internal"],
    });
  });

  test("omits shared membership when the provider lacks sharedCrossAppNetwork", () => {
    const plan = landoNetworkingPlan({
      slug: "shop",
      serviceNames: ["web"],
      sharedCrossAppNetwork: false,
    });
    expect(plan.perAppBridge).toEqual({ name: "lando-shop", driver: "bridge" });
    expect(plan.sharedNetworkMembership).toBeUndefined();
  });

  test("sanitizes the slug into a provider-safe per-app bridge name", () => {
    const plan = landoNetworkingPlan({
      slug: "my app/2",
      serviceNames: [],
      sharedCrossAppNetwork: true,
    });
    expect(plan.perAppBridge.name).toBe("lando-my-app-2");
  });
});

describe("network resolver helpers consume the typed NetworkingPlan", () => {
  const customPlan = {
    slug: "shop",
    networking: {
      perAppBridge: { name: "custom-app-net", driver: "bridge" },
      sharedNetworkMembership: {
        name: "custom-shared-net",
        aliases: { web: ["web.custom.internal"] },
      },
    },
  } as const;

  test("landoAppNetworkName reads the plan's per-app bridge name", () => {
    expect(landoAppNetworkName(customPlan)).toBe("custom-app-net");
  });

  test("landoNetworkNames returns the plan's per-app + shared network names", () => {
    expect(landoNetworkNames(customPlan)).toEqual(["custom-app-net", "custom-shared-net"]);
  });

  test("landoSharedNetworkName reads the plan's shared network name", () => {
    expect(landoSharedNetworkName(customPlan)).toBe("custom-shared-net");
  });

  test("landoServiceNetworkAliases reads the plan's cross-app aliases", () => {
    expect(landoServiceNetworkAliases(customPlan, { name: ServiceName.make("web") })).toEqual([
      "web.custom.internal",
    ]);
  });

  test("a plan that joins no shared network resolves to per-app bridge only", () => {
    const isolated = {
      slug: "shop",
      networking: { perAppBridge: { name: "lando-shop", driver: "bridge" } },
    } as const;
    expect(landoNetworkNames(isolated)).toEqual(["lando-shop"]);
    expect(landoSharedNetworkName(isolated)).toBeUndefined();
    expect(landoServiceNetworkAliases(isolated, { name: ServiceName.make("web") })).toEqual([]);
  });
});

describe("network resolver helpers fall back to slug derivation (legacy plans)", () => {
  const legacyPlan = { slug: "shop" } as const;

  test("landoAppNetworkName derives lando-<slug>", () => {
    expect(landoAppNetworkName(legacyPlan)).toBe("lando-shop");
  });

  test("landoNetworkNames includes the shared network by default", () => {
    expect(landoNetworkNames(legacyPlan)).toEqual(["lando-shop", LANDO_SHARED_CROSS_APP_NETWORK]);
  });

  test("landoServiceNetworkAliases derives <service>.<slug>.internal", () => {
    expect(landoServiceNetworkAliases(legacyPlan, { name: ServiceName.make("web") })).toEqual([
      "web.shop.internal",
    ]);
  });
});
