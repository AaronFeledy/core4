import { expect, test } from "bun:test";
import { makeAppliedPlanCache } from "@lando/container-runtime/applied-plan-cache";
import { rememberAppliedPlan } from "@lando/container-runtime/provider-assembly";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, AppId, type AppPlan, ProviderId, ServiceName } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { restartApp } from "../../src/operations/restart.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

test("preserves persisted selected and unselected metadata when the Landofile changes", async () => {
  // Given an applied two-service app and newer, unrealized intent for both services.
  const db = { ...web, name: ServiceName.make("db"), artifact: { kind: "ref" as const, ref: "db:v1" } };
  const applied: AppPlan = { ...plan, services: { [web.name]: web, [db.name]: db } };
  let persisted: AppPlan | undefined = applied;
  const cache = makeAppliedPlanCache({
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
      [web.name]: { ...web, artifact: { kind: "ref", ref: "web:v2" }, environment: { NEW: "unrealized" } },
      [db.name]: { ...db, artifact: { kind: "ref", ref: "db:v2" } },
    },
  };
  const harness = makeHarness({ plannedApp: desired });
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
      resolveAppliedPlan: () => Effect.succeed(applied),
      select: () =>
        Effect.succeed({
          ...provider,
          apply: (selected, options) =>
            rememberAppliedPlan(cache, selected, options).pipe(Effect.as({ changed: false })),
        }),
    }),
    Effect.provide(harness.layer),
  );

  // When only web is restarted in place.
  await Effect.runPromise(operation);

  // Then neither selected nor unselected unapplied intent becomes applied metadata.
  expect(persisted).toEqual(applied);
});

for (const applied of [
  undefined,
  { ...plan, root: AbsolutePath.make("/another-app") },
  { ...plan, id: AppId.make("another-app") },
  { ...plan, provider: ProviderId.make("docker") },
]) {
  test(`refuses selected restart without matching applied ownership (${applied?.root}/${applied?.id}/${applied?.provider})`, async () => {
    const mutations: string[] = [];
    const harness = makeHarness({
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
        ).pipe(
          Effect.provideService(RuntimeProviderRegistry, {
            ...harness.runtimeProviderRegistry,
            resolveAppliedPlan: () => Effect.succeed(applied),
          }),
          Effect.provide(harness.layer),
        ),
      ),
    );
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(mutations).toEqual([]);
  });
}
