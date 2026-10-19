import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProviderInternalError } from "@lando/sdk/errors";
import { DateTime, Deferred, Effect, Exit, Fiber } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type VolumeIdentity,
  type VolumeRef,
} from "@lando/sdk/schema";
import { StateStore, type StateStoreShape } from "@lando/sdk/services";
import * as StateStoreLayer from "@lando/state-store/service";
import { volumeInitialization } from "@lando/state-store/volume-initialization";
import { withPlanVolumeCoordination } from "../../src/lifecycle/volume-coordination.ts";
import { recordCreatedVolume } from "../../src/lifecycle/volume-initialization.ts";

const identity: VolumeIdentity = {
  coordinationKey: "daemon/data",
  nativeName: "data",
  generation: "one",
  ownerRoot: AbsolutePath.make("/owner"),
  origin: "created",
};
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-09-01T00:00:00Z"),
  source: "test",
  runtime: 4 as const,
};
const plan: AppPlan = {
  id: AppId.make("test"),
  name: "test",
  slug: "test",
  root: identity.ownerRoot,
  provider: ProviderId.make("test"),
  identity: { appRoot: identity.ownerRoot, ownerKey: "owner" },
  services: {
    [ServiceName.make("db")]: {
      name: ServiceName.make("db"),
      type: "mysql",
      provider: ProviderId.make("test"),
      primary: true,
      artifact: { kind: "ref", ref: "mysql:8" },
      environment: {},
      mounts: [],
      storage: [{ store: "data", target: PortablePath.make("/var/lib/mysql"), readOnly: false }],
      endpoints: [],
      routes: [],
      dependsOn: [],
      hostAliases: [],
      metadata,
      extensions: {},
    },
  },
  routes: [],
  networks: [],
  stores: [{ name: "data", scope: "service", kind: "data" }],
  fileSync: [],
  metadata,
  extensions: {},
};

test.each(["created", "existing", "adopted", "replaced", "identity-less", "sibling-lookup-fails"] as const)(
  "apply evidence for %s volumes is fail-closed",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "lando-creation-test-"));
    try {
      const live = await Effect.runPromise(StateStore.pipe(Effect.provide(StateStoreLayer.layer)));
      const store: StateStoreShape = {
        open: (spec) => live.open({ ...spec, root: { path: AbsolutePath.make(root) } }),
        withLock: (_key, body) => body,
      };
      let observations = 0;
      const provider = {
        id: "test",
        locateVolume: (ref: VolumeRef) =>
          ref.store !== identity.nativeName
            ? Effect.fail(
                new ProviderInternalError({
                  providerId: "test",
                  operation: "locateVolume",
                  message: "Sibling lookup failed.",
                }),
              )
            : Effect.sync(() => {
                observations += 1;
                return {
                  coordinationKey: identity.coordinationKey,
                  nativeName: identity.nativeName,
                  identity: {
                    ...identity,
                    origin: kind === "adopted" ? ("adopted" as const) : ("created" as const),
                    generation: kind === "replaced" && observations > 1 ? "two" : "one",
                  },
                };
              }),
      };
      const { identity: _identity, ...identityLessPlan } = plan;
      const receiptPlan =
        kind === "identity-less"
          ? identityLessPlan
          : kind === "sibling-lookup-fails"
            ? {
                ...plan,
                stores: [{ name: "sibling", scope: "app" as const, kind: "data" as const }, ...plan.stores],
              }
            : plan;
      const recorded = await Effect.runPromiseExit(
        (kind === "existing" ? Effect.void : recordCreatedVolume(provider, receiptPlan, identity)).pipe(
          Effect.provideService(StateStore, store),
        ),
      );
      // An identity that cannot be re-verified as this creation fails the apply instead of skipping.
      expect(recorded._tag).toBe(kind === "adopted" || kind === "replaced" ? "Failure" : "Success");
      if (recorded._tag === "Failure") {
        expect(JSON.stringify(recorded.cause)).toContain("could not be verified before recording");
      }
      const state = await Effect.runPromise(volumeInitialization(store, identity));
      expect((await Effect.runPromise(state.read))?.state._tag ?? "unknown").toBe(
        kind === "created" || kind === "identity-less" || kind === "sibling-lookup-fails"
          ? "fresh"
          : "unknown",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test("a rejected creation receipt fails instead of allowing service startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-creation-conflict-test-"));
  try {
    const live = await Effect.runPromise(StateStore.pipe(Effect.provide(StateStoreLayer.layer)));
    const store: StateStoreShape = {
      open: (spec) => live.open({ ...spec, root: { path: AbsolutePath.make(root) } }),
      withLock: (_key, body) => body,
    };
    const conflicting = await Effect.runPromise(
      volumeInitialization(store, {
        ...identity,
        ownerRoot: AbsolutePath.make("/other-owner"),
      }),
    );
    await Effect.runPromise(conflicting.recordCreation);
    const provider = {
      id: "test",
      locateVolume: () =>
        Effect.succeed({
          coordinationKey: identity.coordinationKey,
          nativeName: identity.nativeName,
          identity,
        }),
    };
    const error = await Effect.runPromise(
      recordCreatedVolume(provider, plan, identity).pipe(
        Effect.provideService(StateStore, store),
        Effect.flip,
      ),
    );
    expect(error).toMatchObject({ _tag: "ProviderInternalError", operation: "record-volume-creation" });
    const initialization = await Effect.runPromise(volumeInitialization(store, identity));
    expect(await Effect.runPromise(initialization.read)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("created-volume persistence reuses the active lifecycle volume lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-creation-lock-test-"));
  try {
    const live = await Effect.runPromise(StateStore.pipe(Effect.provide(StateStoreLayer.layer)));
    let lockCalls = 0;
    const store: StateStoreShape = {
      open: (spec) => live.open({ ...spec, root: { path: AbsolutePath.make(root) } }),
      withLock: (_key, body) =>
        Effect.sync(() => {
          lockCalls += 1;
        }).pipe(Effect.andThen(body)),
    };
    const coordinatedPlan: AppPlan = {
      ...plan,
      stores: [{ name: "data", scope: "service", kind: "data" }],
    };
    const provider = {
      id: "test",
      locateVolume: () =>
        Effect.succeed({
          coordinationKey: identity.coordinationKey,
          nativeName: identity.nativeName,
          identity,
        }),
    };

    await Effect.runPromise(
      withPlanVolumeCoordination({
        plan: coordinatedPlan,
        provider,
        stateStore: store,
        body: () =>
          recordCreatedVolume(provider, coordinatedPlan, identity).pipe(
            Effect.provideService(StateStore, store),
          ),
      }),
    );

    expect(lockCalls).toBe(1);
    const state = await Effect.runPromise(volumeInitialization(store, identity));
    expect((await Effect.runPromise(state.read))?.state._tag).toBe("fresh");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cooperative cancellation waits for the creation receipt persist step", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-creation-interrupt-test-"));
  try {
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const live = yield* StateStore.pipe(Effect.provide(StateStoreLayer.layer));
          const writing = yield* Deferred.make<void>();
          const release = yield* Deferred.make<void>();
          const interruptRequested = yield* Deferred.make<void>();
          const store: StateStoreShape = {
            open: (spec) =>
              live.open({ ...spec, root: { path: AbsolutePath.make(root) } }).pipe(
                Effect.map((bucket) => ({
                  ...bucket,
                  modify: (update) =>
                    Deferred.succeed(writing, undefined).pipe(
                      Effect.andThen(Deferred.await(release)),
                      Effect.andThen(bucket.modify(update)),
                    ),
                })),
              ),
            withLock: (_key, body) => body,
          };
          const provider = {
            id: "test",
            locateVolume: () =>
              Effect.succeed({
                coordinationKey: identity.coordinationKey,
                nativeName: identity.nativeName,
                identity,
              }),
          };
          const writer = yield* Effect.forkChild(
            recordCreatedVolume(provider, plan, identity).pipe(Effect.provideService(StateStore, store)),
          );
          yield* Deferred.await(writing);
          const interrupter = yield* Effect.forkChild(
            Deferred.succeed(interruptRequested, undefined).pipe(Effect.andThen(Fiber.interrupt(writer))),
          );
          yield* Deferred.await(interruptRequested);
          yield* Effect.yieldNow;
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(interrupter);
          const exit = yield* Fiber.await(writer);
          const initialization = yield* volumeInitialization(store, identity);
          return { exit, record: yield* initialization.read };
        }),
      ),
    );
    expect(Exit.isFailure(result.exit)).toBe(true);
    expect(result.record?.state._tag).toBe("fresh");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
