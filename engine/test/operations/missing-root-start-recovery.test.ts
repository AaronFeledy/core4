import { expect, test } from "bun:test";
import { FileSyncStopError, ProviderUnavailableError, StateStoreError } from "@lando/sdk/errors";
import type { VolumeInfo } from "@lando/sdk/schema";
import {
  FileSystem,
  RuntimeProviderRegistry,
  type StateBucket,
  type StateBucketSpec,
  StateStore,
} from "@lando/sdk/services";
import { Cause, Effect, Exit, Layer } from "effect";
import { openJournal } from "../../src/operations/accelerated-start-journal.ts";
import { destroyAppAtRoot } from "../../src/operations/destroy.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { acceleratedPlan, app, recoveryHarness } from "./accelerated-start-recovery-support.ts";

const volume: VolumeInfo = {
  ref: { app: app.id, store: "test-start-web-app-mount" },
  identity: {
    nativeName: "test-start-web-app-mount",
    coordinationKey: "key",
    generation: "original",
    ownerRoot: app.root,
    origin: "created",
  },
  labels: {
    "dev.lando.provider": "lando",
    "dev.lando.sync.service": "web",
    "dev.lando.sync.mount-key": "app-mount",
  },
};
const unavailable = new ProviderUnavailableError({
  providerId: "lando",
  operation: "inventory",
  message: "Inventory unavailable",
  remediation: "Restore provider access and retry.",
});

const fixture = async (phase: "preparing" | "apply-intent" = "apply-intent") => {
  const harness = await Effect.runPromise(recoveryHarness({ phase }));
  let volumes: readonly VolumeInfo[] = [volume];
  let listed: readonly VolumeInfo[] | undefined;
  let failInventory = false;
  let interruptRemoval = false;
  let failCompletion = false;
  let vanishAfterListing = false;
  let reappearAfterLookup = false;
  let lookup: "native" | "unknown" | "wrong-name" | "failure" = "native";
  const removed: string[] = [];
  const work = Effect.gen(function* () {
    const fs = yield* FileSystem;
    const registry = yield* RuntimeProviderRegistry;
    const provider = yield* registry.select(acceleratedPlan);
    const store = yield* StateStore;
    return yield* destroyAppAtRoot(app.root, { volumes: true, yes: true }).pipe(
      Effect.provideService(FileSystem, {
        ...fs,
        exists: (path) => (path === app.root ? Effect.succeed(false) : fs.exists(path)),
      }),
      Effect.provideService(RuntimeProviderRegistry, {
        ...registry,
        select: () =>
          Effect.succeed({
            ...provider,
            id: "lando",
            listVolumes: () =>
              Effect.suspend(() => {
                if (failInventory) return Effect.fail(unavailable);
                const observed = listed ?? volumes;
                if (vanishAfterListing) volumes = [];
                return Effect.succeed(observed);
              }),
            locateVolume: (ref) => {
              if (lookup === "failure") return Effect.fail(unavailable);
              const common = {
                coordinationKey: "key",
                nativeName: lookup === "wrong-name" ? "other-volume" : ref.store,
              };
              if (lookup === "unknown") return Effect.succeed(common);
              if (volumes.length === 0) {
                if (reappearAfterLookup) {
                  reappearAfterLookup = false;
                  volumes = [volume];
                }
                return Effect.succeed({ ...common, presence: "absent" as const });
              }
              const identity = volumes[0]?.identity;
              return Effect.succeed({
                ...common,
                presence: "present" as const,
                ...(identity === undefined ? {} : { identity }),
              });
            },
            removeVolume: (ref) =>
              Effect.gen(function* () {
                // The real data plane inspects before deleting, so a vanished volume fails removal.
                if (volumes.length === 0) return yield* Effect.fail(unavailable);
                removed.push(ref.store);
                volumes = [];
                if (interruptRemoval) yield* Effect.interrupt;
              }),
          }),
      }),
      Effect.provideService(StateStore, {
        ...store,
        open: <A, I>(spec: StateBucketSpec<A, I>) =>
          store.open(spec).pipe(
            Effect.map(
              (bucket): StateBucket<A> => ({
                ...bucket,
                transition: (change) =>
                  spec.namespace === "accelerated-starts" && failCompletion
                    ? Effect.fail(
                        new StateStoreError({
                          reason: "io",
                          operation: "transition",
                          path: bucket.path,
                          remediation: "Restore journal access and retry.",
                        }),
                      )
                    : bucket.transition(change),
              }),
            ),
          ),
      }),
    );
  }).pipe(Effect.provide(Layer.merge(harness.layer, BunFileSystem.layer)));
  const journal = () =>
    Effect.runPromise(
      openJournal(app).pipe(
        Effect.flatMap((bucket) => bucket.get),
        Effect.provide(harness.layer),
      ),
    );
  return {
    harness,
    removed,
    journal,
    run: () => Effect.runPromiseExit(work),
    failCompletion: (value: boolean) => {
      failCompletion = value;
    },
    interruptRemoval: (value: boolean) => {
      interruptRemoval = value;
    },
    failInventory: () => {
      failInventory = true;
    },
    vanishAfterListing: () => {
      vanishAfterListing = true;
    },
    reappearAfterLookup: () => {
      reappearAfterLookup = true;
    },
    hideVolumes: () => {
      listed = [];
    },
    lookup: (value: typeof lookup) => {
      lookup = value;
    },
    replace: (replacement: readonly VolumeInfo[]) => {
      volumes = replacement;
    },
  };
};

test.each(["completion-failure", "interruption"] as const)(
  "missing-root destroy recovers after target deletion and %s",
  async (failure) => {
    const f = await fixture();
    f.failCompletion(failure === "completion-failure");
    f.interruptRemoval(failure === "interruption");
    const first = await f.run();
    expect(Exit.isFailure(first)).toBe(true);
    if (failure === "interruption")
      expect(Exit.isFailure(first) && Cause.hasInterrupts(first.cause)).toBe(true);
    expect(f.removed).toEqual([volume.ref.store]);
    expect(await f.journal()).not.toBeNull();
    f.failCompletion(false);
    f.interruptRemoval(false);

    const retried = await f.run();

    expect(Exit.isSuccess(retried)).toBe(true);
    expect(await f.journal()).toBeNull();
    expect(f.removed).toEqual([volume.ref.store]);
    expect(f.harness.calls.filter((call) => call.startsWith("terminate:"))).toEqual(["terminate:old"]);
  },
);

test("missing-root destroy skips a target that earlier teardown already removed", async () => {
  const f = await fixture();
  f.vanishAfterListing();

  const result = await f.run();

  expect(Exit.isSuccess(result)).toBe(true);
  expect(f.removed).toEqual([]);
  expect(await f.journal()).toBeNull();
});

test("missing-root destroy keeps the journal when a target verified absent reappears", async () => {
  const f = await fixture();
  f.replace([]);
  f.reappearAfterLookup();

  const result = await f.run();

  expect(Exit.isFailure(result)).toBe(true);
  expect(f.removed).toEqual([]);
  expect(await f.journal()).not.toBeNull();
});

test.each(["preparing", "apply-intent"] as const)(
  "missing-root destroy accepts authoritative session absence at %s",
  async (phase) => {
    const f = await fixture(phase);
    // Planned identities at preparing do not prove creation. At apply-intent,
    // no surviving session can write, and --volumes explicitly discards its data.
    f.harness.sessions.splice(0);

    const result = await f.run();

    expect(Exit.isSuccess(result)).toBe(true);
    expect(f.removed).toEqual([volume.ref.store]);
    expect(await f.journal()).toBeNull();
  },
);

test.each(["foreign", "unlisted", "inventory-failure", "unknown", "wrong-name", "failure"] as const)(
  "missing-root recovery preserves the journal on %s evidence",
  async (evidence) => {
    const f = await fixture();
    f.failCompletion(true);
    await f.run();
    f.failCompletion(false);
    switch (evidence) {
      case "foreign":
        f.replace([{ ...volume, labels: { ...volume.labels, "dev.lando.provider": "foreign" } }]);
        break;
      case "unlisted":
        f.replace([volume]);
        f.hideVolumes();
        break;
      case "inventory-failure":
        f.failInventory();
        break;
      case "unknown":
      case "wrong-name":
      case "failure":
        f.lookup(evidence);
        break;
    }

    const retried = await f.run();

    expect(Exit.isFailure(retried)).toBe(true);
    expect(await f.journal()).not.toBeNull();
    expect(f.removed).toEqual([volume.ref.store]);
  },
);

test("missing-root destroy preserves copies when session inventory fails", async () => {
  const failure = new FileSyncStopError({
    engineId: "mutagen",
    sessionRef: app.id,
    message: "Daemon inventory differs from ownership receipts.",
    remediation: "Restore engine ownership and retry.",
  });
  const harness = await Effect.runPromise(
    recoveryHarness({ engineOverrides: { listSessions: () => Effect.fail(failure) } }),
  );
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const fs = yield* FileSystem;
      return yield* destroyAppAtRoot(app.root, { volumes: true, yes: true }).pipe(
        Effect.provideService(FileSystem, { ...fs, exists: () => Effect.succeed(false) }),
        Effect.result,
      );
    }).pipe(Effect.provide(Layer.merge(harness.layer, BunFileSystem.layer))),
  );
  expect(result).toMatchObject({ _tag: "Failure", failure });
  expect(harness.calls).toEqual([]);
  expect(
    await Effect.runPromise(
      openJournal(app).pipe(
        Effect.flatMap((bucket) => bucket.get),
        Effect.provide(harness.layer),
      ),
    ),
  ).not.toBeNull();
});
