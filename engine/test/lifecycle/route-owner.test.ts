import { describe, expect, test } from "bun:test";

import { AbsolutePath, AppId, appIdentityKey, planAppIdentity } from "@lando/sdk/schema";

import { RouterService } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";
import { Effect } from "effect";
import {
  routeOwnerFromGlobalTeardown,
  routeOwnerFromPlan,
  routeOwnerFromScratch,
} from "../../src/lifecycle/route-owner.ts";
import { makeScratchReaper } from "../../src/scratch-app/destroy.ts";
import { SCRATCH_EXTENSION_KEY } from "../../src/scratch-app/identity.ts";
import { withDestroyFixture } from "../scratch-app/destroy-fixture.ts";

describe("routeOwnerFromPlan", () => {
  test("uses planAppIdentity ownerKey including identity-less plans", () => {
    // Given
    const root = AbsolutePath.make("/srv/apps/demo");
    const plan = { id: AppId.make("demo"), root, extensions: {} };

    // When / Then
    expect(routeOwnerFromPlan(plan)).toEqual({
      id: plan.id,
      ownerKey: planAppIdentity(plan).ownerKey,
    });
    expect(routeOwnerFromPlan(plan).ownerKey).toBe(appIdentityKey("owner", String(root)));
  });

  test("prefers stamped identity over root fallback", () => {
    // Given
    const root = AbsolutePath.make("/srv/apps/demo");
    const identity = {
      appRoot: AbsolutePath.make("/canonical/demo"),
      ownerKey: appIdentityKey("owner", "/canonical/demo"),
    };
    const plan = { id: AppId.make("demo"), root, identity, extensions: {} };

    // When / Then
    expect(routeOwnerFromPlan(plan).ownerKey).toBe(identity.ownerKey);
  });
});

describe("routeOwnerFromScratch", () => {
  test("cwd scratch plans and their source have distinct route owners", () => {
    // Given: two scratch instances materializing the same cwd source root
    const cwd = AbsolutePath.make("/home/user/project");
    const source = { id: AppId.make("source"), root: cwd, extensions: {} };

    // When
    const scratch = {
      ...source,
      id: AppId.make("scratch-a-111111"),
      extensions: { [SCRATCH_EXTENSION_KEY]: { id: "scratch-a-111111" } },
    };
    const ownerA = routeOwnerFromPlan(scratch);
    const ownerB = routeOwnerFromScratch("scratch-b-222222");

    // Then
    expect(ownerA.ownerKey).not.toBe(ownerB.ownerKey);
    expect(ownerA.ownerKey).not.toBe(routeOwnerFromPlan(source).ownerKey);
    expect(ownerA).toEqual(routeOwnerFromScratch(scratch.id));
  });

  test("destroy without a cached plan withdraws scratch routes while preserving source routes", async () => {
    await withDestroyFixture({ orphan: true, cwd: true }, async (fixture) => {
      const router = makeTestRouterService();
      const sourceOwner = routeOwnerFromPlan(fixture.plan);
      const scratchOwner = routeOwnerFromScratch(fixture.id);
      await Effect.runPromise(router.applyRoutes([], sourceOwner));
      await Effect.runPromise(router.applyRoutes([], scratchOwner));

      await Effect.runPromise(
        Effect.gen(function* () {
          const reap = yield* makeScratchReaper;
          yield* reap({ id: fixture.id, instanceRoot: fixture.instanceRoot, reason: "explicit" });
        }).pipe(Effect.provideService(RouterService, router), Effect.provide(fixture.layer)),
      );

      expect((await Effect.runPromise(router.status)).configuredApps).toEqual([sourceOwner.id]);
    });
  });
});

describe("routeOwnerFromGlobalTeardown", () => {
  test("prefers recorded applied-plan identity", () => {
    // Given
    const plan = {
      id: AppId.make("global"),
      root: AbsolutePath.make("/data/global"),
      extensions: {},
      identity: {
        appRoot: AbsolutePath.make("/canonical/global"),
        ownerKey: appIdentityKey("owner", "/canonical/global"),
      },
    };

    // When
    const owner = routeOwnerFromGlobalTeardown({
      paths: { root: AbsolutePath.make("/other/global") },
      evidence: { kind: "applied", plan },
    });

    // Then
    expect(owner).toEqual(routeOwnerFromPlan(plan));
  });

  test("falls back to the canonical global root when evidence is absent", () => {
    // Given
    const root = AbsolutePath.make("/data/global");

    // When
    const owner = routeOwnerFromGlobalTeardown({
      paths: { root },
      evidence: { kind: "absent" },
    });

    // Then
    expect(owner).toEqual({
      id: AppId.make("global"),
      ownerKey: appIdentityKey("owner", String(root)),
    });
  });
});
