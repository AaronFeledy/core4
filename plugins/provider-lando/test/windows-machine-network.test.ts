import { describe, expect, test } from "bun:test";

import { type AppPlan, landoNetworkingPlan } from "@lando/sdk/schema";

import { windowsMachineNetworkPlan } from "../src/windows-machine-network.ts";

const plan = {
  id: "site",
  slug: "site",
  services: { web: { name: "web" }, database: { name: "database" } },
  networking: {
    perAppBridge: { name: "lando-site", driver: "bridge" },
    sharedNetworkMembership: {
      name: "lando_bridge_network",
      aliases: { web: ["web.site.internal"], database: ["database.site.internal"] },
    },
  },
} as unknown as AppPlan;

describe("Windows managed-machine physical network names", () => {
  test("renames owned authored networks while preserving external names, members and aliases", () => {
    // Given
    const logical = {
      ...plan,
      networking: landoNetworkingPlan({
        slug: plan.slug,
        serviceNames: ["web"],
        sharedCrossAppNetwork: true,
        bridgeAliases: { web: ["frontend"] },
        authoredNetworks: [
          { key: "extra", external: false, members: { web: ["alias"] } },
          { key: "sibling", external: true, name: "sibling_default", members: { web: ["shared-alias"] } },
        ],
      }),
    };
    // When
    const physical = windowsMachineNetworkPlan(logical, "2026-09-22T08:16:19Z");
    // Then
    expect(physical.networking?.authoredNetworks?.[0]?.name).toMatch(/^lando-vm-[0-9a-f]{12}-[0-9a-f]{12}$/u);
    expect(physical.networking?.authoredNetworks?.[0]?.members).toEqual(
      logical.networking.authoredNetworks?.[0]?.members,
    );
    expect(physical.networking?.authoredNetworks?.[1]).toEqual(logical.networking.authoredNetworks?.[1]);
    expect(physical.networking?.perAppBridge?.aliases).toEqual(logical.networking.perAppBridge?.aliases);
    expect(windowsMachineNetworkPlan(physical, "2026-09-22T08:16:19Z")).toEqual(physical);
    expect(
      windowsMachineNetworkPlan(logical, "2026-09-23T08:16:19Z").networking?.authoredNetworks?.[0]?.name,
    ).not.toBe(physical.networking?.authoredNetworks?.[0]?.name);
  });
  test("maps private and shared network names consistently for one machine", () => {
    const first = windowsMachineNetworkPlan(plan, "2026-09-22T08:16:19Z");
    const repeated = windowsMachineNetworkPlan(plan, "2026-09-22T08:16:19Z");
    expect(first.networking).toEqual(repeated.networking);
    expect(windowsMachineNetworkPlan(first, "2026-09-22T08:16:19Z").networking).toEqual(first.networking);
    expect(first.networking?.perAppBridge?.name).toMatch(/^lando-vm-[0-9a-f]{12}-[0-9a-f]{12}$/u);
    expect(first.networking?.sharedNetworkMembership?.name).toMatch(/^lando-vm-[0-9a-f]{12}-[0-9a-f]{12}$/u);
    expect(first.networking?.perAppBridge?.name).not.toBe(first.networking?.sharedNetworkMembership?.name);
    expect(first.networking?.sharedNetworkMembership?.aliases).toEqual(
      plan.networking?.sharedNetworkMembership?.aliases,
    );
    expect(first.services).toBe(plan.services);
  });

  test("global and app plans share one physical cross-app network", () => {
    const networking = plan.networking;
    if (networking === undefined) throw new Error("Network fixture missing");
    const global = {
      ...plan,
      id: "global",
      slug: "global",
      networking: { ...networking, perAppBridge: null },
    } as AppPlan;
    const app = windowsMachineNetworkPlan(plan, "2026-09-22T08:16:19Z");
    const globalPhysical = windowsMachineNetworkPlan(global, "2026-09-22T08:16:19Z");
    expect(app.networking?.sharedNetworkMembership?.name).toBe(
      globalPhysical.networking?.sharedNetworkMembership?.name,
    );
    expect(app.networking?.perAppBridge?.name).toBeDefined();
    expect(globalPhysical.networking?.perAppBridge).toBeNull();
  });
  test("a replacement machine gets distinct physical networks without changing logical aliases", () => {
    const old = windowsMachineNetworkPlan(plan, "2026-09-22T08:16:19Z");
    const next = windowsMachineNetworkPlan(plan, "2026-09-23T08:16:19Z");
    expect(next.networking?.perAppBridge?.name).not.toBe(old.networking?.perAppBridge?.name);
    expect(next.networking?.sharedNetworkMembership?.name).not.toBe(
      old.networking?.sharedNetworkMembership?.name,
    );
    expect(next.networking?.sharedNetworkMembership?.aliases).toEqual(
      old.networking?.sharedNetworkMembership?.aliases,
    );
    expect(() => windowsMachineNetworkPlan(old, "2026-09-23T08:16:19Z")).toThrow();
  });
});
