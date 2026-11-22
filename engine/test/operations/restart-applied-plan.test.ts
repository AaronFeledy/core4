import { expect, test } from "bun:test";
import { makeAppliedPlanCache } from "@lando/container-runtime/applied-plan-cache";
import { rememberAppliedPlan } from "@lando/container-runtime/provider-assembly";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type AppliedAppPlan,
  ProviderId,
  ServiceName,
  appIdentityKey,
} from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { restartApp } from "../../src/operations/restart.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

const db = { ...web, name: ServiceName.make("db"), artifact: { kind: "ref" as const, ref: "db:v1" } };
const cache = {
  ...web,
  name: ServiceName.make("cache"),
  artifact: { kind: "ref" as const, ref: "cache:v1" },
};

test("records selected runtime metadata, carries unselected services, and keeps removed ones", async () => {
  // Given an applied three-service app and newer, unrealized intent for the selected and unselected ones.
  const { events: _events, ...realized } = plan;
  const applied: AppliedAppPlan = {
    ...realized,
    services: {
      [web.name]: { ...web, artifact: { kind: "ref", ref: "web:v1" } },
      [db.name]: db,
      [cache.name]: cache,
    },
  };
  let persisted: AppliedAppPlan | undefined = applied;
  const cacheStore = makeAppliedPlanCache({
    providerId: plan.provider,
    providerName: "test",
    appliedPlanState: { open: () => Effect.die("unused"), withLock: (_key, body) => body },
    load: () => Effect.succeed(persisted),
    persist: (_state, value) =>
      Effect.sync(() => {
        persisted = value;
      }),
    remove: () => Effect.void,
  });
  const desired: AppPlan = {
    ...applied,
    services: {
      [web.name]: { ...web, artifact: { kind: "ref", ref: "web:v2" } },
      [db.name]: { ...db, artifact: { kind: "ref", ref: "db:v2" } },
    },
  };
  const harness = makeHarness({
    plannedApp: desired,
    resolveAppliedPlan: () => Effect.succeed(applied),
    // The artifact build stamps the runtime metadata the selected service is applied with.
    buildResult: (buildPlan) => {
      const selected = buildPlan.services[web.name];
      return buildPlan.id !== desired.id || selected === undefined
        ? buildPlan
        : {
            ...buildPlan,
            services: {
              ...buildPlan.services,
              [web.name]: { ...selected, environment: { APPLIED: "yes" } },
            },
          };
    },
  });
  const provider = await Effect.runPromise(harness.runtimeProviderRegistry.select());
  const operation = restartApp(
    { services: [web.name] },
    {
      plan: desired,
      root: desired.root,
      app: { kind: "user", id: desired.id, root: desired.root },
    },
  ).pipe(
    Effect.provideService(RuntimeProviderRegistry, {
      ...harness.runtimeProviderRegistry,
      select: () =>
        Effect.succeed({
          ...provider,
          apply: (selected, options) =>
            rememberAppliedPlan(cacheStore, selected, options).pipe(Effect.as({ changed: false })),
        }),
    }),
    Effect.provide(harness.layer),
  );

  // When only web is restarted.
  await Effect.runPromise(operation);

  // Then the record carries db from the previous record, keeps the removed cache service, and
  // stores the applied metadata of the selected service.
  if (persisted === undefined) throw new TypeError("expected a persisted applied plan");
  expect(persisted.services[db.name]).toEqual(applied.services[db.name]);
  expect(persisted.services[cache.name]).toEqual(applied.services[cache.name]);
  expect(persisted.services[web.name]?.artifact).toEqual({ kind: "ref", ref: "web:v2" });
  expect(persisted.services[web.name]?.environment).toEqual({ APPLIED: "yes" });
});

for (const [applied, refusal] of [
  [undefined, "ProviderUnavailableError"],
  [
    {
      ...plan,
      root: AbsolutePath.make("/another-app"),
      identity: {
        appRoot: AbsolutePath.make("/another-app"),
        ownerKey: appIdentityKey("owner", "/another-app"),
        dataName: "another-app",
      },
    },
    "ProviderUnavailableError",
  ],
  // A same-root plan under another app id is a pending rename, which a selected restart refuses.
  [{ ...plan, id: AppId.make("another-app") }, "AppResolveError"],
  [{ ...plan, provider: ProviderId.make("docker") }, "AppPlacementError"],
] as const) {
  test(`refuses selected restart without matching applied ownership (${applied?.root}/${applied?.id}/${applied?.provider})`, async () => {
    const mutations: string[] = [];
    const harness = makeHarness({
      resolveAppliedPlan: () => Effect.succeed(applied),
      onStop: () => {
        mutations.push("stop");
      },
      onApply: () => {
        mutations.push("apply");
      },
    });
    const error = await Effect.runPromise(
      Effect.flip(
        restartApp(
          { services: [web.name] },
          {
            plan,
            root: plan.root,
            app: { kind: "user", id: plan.id, root: plan.root },
          },
        ).pipe(Effect.provide(harness.layer)),
      ),
    );
    expect(error._tag).toBe(refusal);
    expect(mutations).toEqual([]);
  });
}
