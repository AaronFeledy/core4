import { describe, expect, test } from "bun:test";

import { DateTime } from "effect";

import { AbsolutePath, AppId, type AppPlan, ProviderId, appIdentityKey } from "@lando/sdk/schema";

import { podmanVolumeCreationLabels } from "../src/podman/bring-up.ts";
import { renderCompose } from "../src/podman/compose.ts";
import { buildLandoVolumeFilters, volumeMatchesFilters } from "../src/podman/volume-prune.ts";

const ctx = { providerId: "lando", remediation: "Run `lando setup` and retry." } as const;
const appRoot = AbsolutePath.make("/srv/apps/ownership");
const dataStore = { name: "ownership_database_data", scope: "app", kind: "data" } as const;
const cacheStore = { name: "lando-cache-npm", scope: "global", kind: "cache", key: "npm" } as const;

/** A plan as the planner stamps it: `root` is the canonical root and `identity` is derived from it. */
const plannedPlan: AppPlan = {
  id: AppId.make("ownership"),
  name: "ownership",
  slug: "ownership",
  root: appRoot,
  provider: ProviderId.make("lando"),
  identity: { appRoot, ownerKey: appIdentityKey("owner", appRoot) },
  services: {},
  routes: [],
  networks: [],
  stores: [dataStore, cacheStore],
  fileSync: [],
  metadata: { resolvedAt: DateTime.unsafeMake("2026-09-01T00:00:00Z"), source: "test", runtime: 4 },
  extensions: {},
};

/** The same app carried on a plan that lost `identity` (hand-built, or decoded from older state). */
const identitylessPlan: AppPlan = { ...plannedPlan, identity: undefined };

const composeVolumeLabels = (plan: AppPlan, store: string): Readonly<Record<string, unknown>> => {
  const document = Bun.YAML.parse(renderCompose(plan, ctx)) as {
    readonly volumes?: Record<string, { readonly labels?: Record<string, unknown> }>;
  };
  return document.volumes?.[store]?.labels ?? {};
};

const readerFilters = (plan: AppPlan, volumeClass: "cache" | "data") =>
  buildLandoVolumeFilters(plan.id, {
    providerId: plan.provider,
    ownerKey: appIdentityKey("owner", plan.root),
    volumeClasses: [volumeClass],
  });

describe("volume ownership selector", () => {
  test("a selector written without identity.ownerKey is matched by the reading side", () => {
    const written = podmanVolumeCreationLabels(identitylessPlan, dataStore);

    expect(volumeMatchesFilters(written, readerFilters(identitylessPlan, "data"))).toBe(true);
  });

  test("the create path writes the owner label for every plan, identity or not", () => {
    const written = podmanVolumeCreationLabels(identitylessPlan, dataStore);

    expect(written["dev.lando.volume-owner"]).toBe(appRoot);
  });

  test("compose emits the same ownership labels the create path writes", () => {
    const written = podmanVolumeCreationLabels(identitylessPlan, cacheStore);
    const rendered = composeVolumeLabels(identitylessPlan, cacheStore.name);

    expect(rendered["dev.lando.volume-selector"]).toBe(written["dev.lando.volume-selector"]);
    expect(rendered["dev.lando.volume-owner"]).toBe(written["dev.lando.volume-owner"]);
  });

  test("the selector's owner key is derived from the owner label it is written beside", () => {
    for (const plan of [plannedPlan, identitylessPlan]) {
      for (const store of [dataStore, cacheStore]) {
        const written = podmanVolumeCreationLabels(plan, store);
        const owner = written["dev.lando.volume-owner"] ?? "";

        expect(written["dev.lando.volume-selector"]?.split(":")[2]).toBe(appIdentityKey("owner", owner));
      }
    }
  });

  test("a plan that lost its identity writes exactly what the planned plan writes", () => {
    for (const store of [dataStore, cacheStore]) {
      expect(podmanVolumeCreationLabels(identitylessPlan, store)["dev.lando.volume-selector"]).toBe(
        podmanVolumeCreationLabels(plannedPlan, store)["dev.lando.volume-selector"],
      );
    }
  });

  test("creation ownership binds to the canonical identity, not the plan root", () => {
    const adopted: AppPlan = {
      ...plannedPlan,
      root: AbsolutePath.make("/srv/apps/symlinked"),
      identity: { appRoot, ownerKey: appIdentityKey("owner", appRoot) },
    };
    const written = podmanVolumeCreationLabels(adopted, dataStore);

    expect(written["dev.lando.volume-owner"]).toBe(appRoot);
    expect(written["dev.lando.volume-selector"]).toBe(
      podmanVolumeCreationLabels(plannedPlan, dataStore)["dev.lando.volume-selector"],
    );
  });

  test("another app's volume is still rejected by the reading side", () => {
    const foreign = podmanVolumeCreationLabels(
      { ...identitylessPlan, id: AppId.make("other"), root: AbsolutePath.make("/srv/apps/other") },
      dataStore,
    );

    expect(volumeMatchesFilters(foreign, readerFilters(plannedPlan, "data"))).toBe(false);
  });
});
