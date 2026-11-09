import { expect, test } from "bun:test";
import { AppDataIdentityError, ProviderUnavailableError } from "@lando/sdk/errors";
import { AppPlanner, EventService, RuntimeProviderRegistry } from "@lando/sdk/services";
import { Deferred, Effect, Fiber } from "effect";
import {
  APP_LOCK_WAIT_MESSAGE,
  appLockTarget,
  withAppMutationLock,
} from "../../src/operations/app-mutation-lock.ts";
import { claimAppDataIdentity } from "../../src/operations/data-identity-claim.ts";
import { reconcileAppDataIdentity } from "../../src/operations/data-identity-reconcile.ts";
import { startApp } from "../../src/operations/start.ts";
import { readAppDataIdentity, recordAppDataIdentity } from "../../src/planner/data-identity.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import {
  identity,
  identityPlan,
  identityPlanner,
  identityRegistry,
  identityTarget,
} from "./data-identity-support.ts";
import { makeHarness } from "./start-progress-topology-support.ts";

test("reconcile prefers the durable name over applied and prepared plan names", async () => {
  const store = makeTestStateStore();
  const prepared = identityPlan("current", "current");
  await Effect.runPromise(recordAppDataIdentity(identity, "recorded").pipe(Effect.provide(store.layer)));
  const result = await Effect.runPromise(
    reconcileAppDataIdentity(identityTarget(prepared)).pipe(
      Effect.provide(store.layer),
      Effect.provideService(RuntimeProviderRegistry, identityRegistry([identityPlan("applied", "applied")])),
      Effect.provideService(AppPlanner, identityPlanner(prepared)),
    ),
  );
  expect(result.plan.identity?.dataName).toBe("recorded");
});

test("reconcile seeds from a legacy same-root applied plan", async () => {
  const store = makeTestStateStore();
  const prepared = identityPlan("renamed", "renamed");
  const result = await Effect.runPromise(
    reconcileAppDataIdentity(identityTarget(prepared)).pipe(
      Effect.provide(store.layer),
      Effect.provideService(RuntimeProviderRegistry, identityRegistry([identityPlan("original")])),
      Effect.provideService(AppPlanner, identityPlanner(prepared)),
    ),
  );
  expect(result.plan.identity?.dataName).toBe("original");
});

test.each([undefined, "renamed"])(
  "reconcile fails closed without a Landofile when stamped name is %s",
  async (stamped) => {
    const store = makeTestStateStore();
    const result = await Effect.runPromise(
      reconcileAppDataIdentity(identityTarget(identityPlan("renamed", stamped), false)).pipe(
        Effect.provide(store.layer),
        Effect.provideService(RuntimeProviderRegistry, identityRegistry([identityPlan("original")])),
        Effect.provideService(AppPlanner, identityPlanner(identityPlan("renamed"))),
        Effect.result,
      ),
    );
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "AppDataIdentityError" },
    });
    expect(result._tag === "Failure" && result.failure instanceof AppDataIdentityError).toBe(true);
  },
);

test.each(["scratch", "global"] as const)(
  "%s launch never reads or claims user data identity",
  async (kind) => {
    const store = makeTestStateStore();
    const target = {
      ...identityTarget(identityPlan("current", "original")),
      app: { ...identityTarget(identityPlan("current")).app, kind },
    };
    const result = await Effect.runPromise(
      reconcileAppDataIdentity(target).pipe(
        Effect.provide(store.layer),
        Effect.provideService(RuntimeProviderRegistry, {
          ...identityRegistry(),
          appliedPlansFor: () => Effect.die("must not read applied plans"),
        }),
        Effect.provideService(AppPlanner, identityPlanner(target.plan)),
      ),
    );
    await Effect.runPromise(claimAppDataIdentity(target).pipe(Effect.provide(store.layer)));
    expect(result).toBe(target);
    expect(store.snapshot().size).toBe(0);
  },
);

test("a failed first apply followed by rename keeps the first data name", async () => {
  const store = makeTestStateStore();
  const first = identityPlan("first", "first");
  const failure = new ProviderUnavailableError({
    providerId: "lando",
    operation: "apply",
    message: "apply failed",
    remediation: "retry",
  });
  const failed = makeHarness({ plannedApp: first, stateStore: store, applyEffect: Effect.fail(failure) });
  const result = await Effect.runPromise(
    startApp({}, identityTarget(first)).pipe(Effect.provide(failed.layer), Effect.result),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderUnavailableError" } });
  expect(await Effect.runPromise(readAppDataIdentity(identity).pipe(Effect.provide(store.layer)))).toEqual({
    name: "first",
  });
  const renamed = identityPlan("second", "second");
  let appliedName: string | undefined;
  const resumed = makeHarness({
    plannedApp: renamed,
    stateStore: store,
    onApply: (plan) => {
      appliedName = plan.identity?.dataName;
    },
  });
  await Effect.runPromise(startApp({}, identityTarget(renamed)).pipe(Effect.provide(resumed.layer)));
  expect(appliedName).toBe("first");
  expect(await Effect.runPromise(readAppDataIdentity(identity).pipe(Effect.provide(store.layer)))).toEqual({
    name: "first",
  });
});

test("a prepared plan re-reads a competing data claim after acquiring the root lock", async () => {
  const store = makeTestStateStore();
  const prepared = identityPlan("current", "current");
  let appliedName: string | undefined;
  const harness = makeHarness({
    plannedApp: prepared,
    stateStore: store,
    onApply: (plan) => {
      appliedName = plan.identity?.dataName;
    },
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const acquired = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const waiting = yield* Deferred.make<void>();
        const events = yield* EventService;
        const holder = yield* withAppMutationLock(
          appLockTarget(prepared),
          Effect.gen(function* () {
            yield* Deferred.succeed(acquired, undefined);
            yield* Deferred.await(release);
            yield* recordAppDataIdentity(identity, "competing");
          }),
        ).pipe(Effect.forkChild);
        yield* Deferred.await(acquired);
        const starter = yield* startApp({}, identityTarget(prepared)).pipe(
          Effect.provideService(EventService, {
            ...events,
            publish: (event) =>
              events
                .publish(event)
                .pipe(
                  Effect.andThen(
                    event._tag === "message.warn" && event.body === APP_LOCK_WAIT_MESSAGE
                      ? Deferred.succeed(waiting, undefined)
                      : Effect.void,
                  ),
                ),
          }),
          Effect.forkChild,
        );
        yield* Deferred.await(waiting);
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.join(holder);
        yield* Fiber.join(starter);
      }),
    ).pipe(Effect.provide(harness.layer), Effect.timeout("5 seconds")),
  );
  expect(appliedName).toBe("competing");
});

test("retirement failure cannot erase the only legacy data-name seed", async () => {
  const store = makeTestStateStore();
  const prepared = identityPlan("current", "current");
  const applied = [identityPlan("original")];
  const failure = new ProviderUnavailableError({
    providerId: "lando",
    operation: "destroy",
    message: "retirement interrupted",
    remediation: "retry",
  });
  const harness = makeHarness({
    plannedApp: prepared,
    stateStore: store,
    appliedPlans: applied,
    onDestroy: () => {
      applied.splice(0);
    },
    destroyEffect: Effect.fail(failure),
  });
  const result = await Effect.runPromise(
    startApp({}, identityTarget(prepared)).pipe(Effect.provide(harness.layer), Effect.result),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "ProviderUnavailableError" } });
  expect(applied).toEqual([]);
  expect(await Effect.runPromise(readAppDataIdentity(identity).pipe(Effect.provide(store.layer)))).toEqual({
    name: "original",
  });
});
