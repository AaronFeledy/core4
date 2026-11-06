import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FileSyncStartError, FileSyncStopError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AbsolutePath, ServiceName } from "@lando/sdk/schema";
import { makePluginStateStore } from "@lando/state-store/plugin";
import { makeTestStateStore } from "@lando/state-store/testing";
import { Cause, Effect, Exit } from "effect";
import type { MutagenProcessClient } from "../src/mutagen-process-client.ts";
import { openLedger } from "../src/session-ledger.ts";
import { fake, id, name, privateFileAccess, runDisposalPlan, spec } from "./support/mutagen-process.ts";

test.each([
  { operation: "invalidateAppDrain", edge: "invalidate-drain", to: "invalidated", tag: "FileSyncStartError" },
  { operation: "drainApp", edge: "begin-drain", to: "preparing", tag: "FileSyncStopError" },
] as const)(
  "$operation rejects completed ownership without changing ledger bytes",
  async ({ operation, edge, to, tag }) => {
    const root = await mkdtemp(join(tmpdir(), "lando-mutagen-illegal-"));
    try {
      const memory = makeTestStateStore();
      const stateStore = makePluginStateStore(memory.service, AbsolutePath.make(root), privateFileAccess);
      const harness = fake({ stateStore });
      await Effect.runPromise(harness.client.create({ name, spec }));
      const bucket = await Effect.runPromise(openLedger(stateStore));
      const current = await Effect.runPromise(bucket.get);
      if (current === null) throw new TypeError("Expected create receipt");
      await Effect.runPromise(
        bucket.set({ ...current, appDrains: [{ app: spec.app, phase: "completed", identifiers: [id] }] }),
      );
      const before = await Effect.runPromise(memory.readRaw(bucket.path));

      const action: Effect.Effect<void, FileSyncStartError | FileSyncStopError> = harness
        .reopen()
        [operation](spec.app);
      const result = await Effect.runPromiseExit(action);

      expect(Exit.isFailure(result)).toBe(true);
      if (Exit.isFailure(result)) {
        const failure = Cause.findErrorOption(result.cause);
        expect(failure._tag).toBe("Some");
        if (failure._tag === "Some") {
          expect(failure.value._tag).toBe(tag);
          expect(failure.value.message).toContain(`Mutagen app "cms" cannot ${edge} while completed`);
          expect(failure.value.message).toContain(`to ${to}.`);
          expect(failure.value.message).toContain("lando destroy");
          expect(failure.value.message).toContain("lando start");
        }
      }
      expect(await Effect.runPromise(memory.readRaw(bucket.path))).toEqual(before);
      expect(harness.current().map((entry) => entry.identifier)).toEqual([id]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

const cycle = Effect.fnUntraced(function* (client: MutagenProcessClient) {
  yield* client.create({ name, spec });
  yield* client.create({ name: "cms-api-app-root", spec: { ...spec, service: ServiceName.make("api") } });
  yield* client.invalidateAppDrain(spec.app);
  yield* client.drainApp(spec.app);
  yield* client.disposeApp(spec.app);
  yield* client.completeAppDisposal(spec.app);
});

const initialStates = ["fresh", "completed", "uncreated", "created"] as const;
type InitialState = (typeof initialStates)[number];

const prepare = async (root: string, initial: InitialState) => {
  const memory = makeTestStateStore();
  const stateStore = makePluginStateStore(memory.service, AbsolutePath.make(root), privateFileAccess);
  const options = { stateStore, failCreateOnce: initial === "uncreated", ambiguousId: initial === "created" };
  const harness = fake(options);
  switch (initial) {
    case "completed":
      await Effect.runPromise(cycle(harness.client));
      break;
    case "uncreated":
    case "created":
      expect(Exit.isFailure(await Effect.runPromiseExit(harness.client.create({ name, spec })))).toBe(true);
      options.ambiguousId = false;
      break;
    case "fresh":
      break;
    default: {
      const exhaustive: never = initial;
      return exhaustive;
    }
  }
  return harness;
};

const interruptWrites = (stateStore: PluginStateStore, after: number) => {
  let writes = 0;
  const store: PluginStateStore = {
    ...stateStore,
    open: (bucketSpec) =>
      stateStore.open(bucketSpec).pipe(
        Effect.map((bucket) => ({
          ...bucket,
          // Count only writes that reach the file; a settled (Keep) mutation is not a write.
          mutate: (f) => {
            let wrote = false;
            return bucket
              .mutate((current) =>
                f(current).pipe(
                  Effect.tap((write) =>
                    Effect.sync(() => {
                      wrote = write._tag !== "Keep";
                    }),
                  ),
                ),
              )
              .pipe(
                Effect.tap(() =>
                  Effect.suspend(() => {
                    if (!wrote) return Effect.void;
                    writes += 1;
                    return writes === after ? Effect.interrupt : Effect.void;
                  }),
                ),
              );
          },
        })),
      ),
  };
  return { store, writes: () => writes };
};

test.each(initialStates)(
  "%s lifecycle converges after interruption at every successful ledger write",
  async (initial) => {
    const root = await mkdtemp(join(tmpdir(), "lando-mutagen-interrupt-"));
    try {
      const baseline = await prepare(root, initial);
      const recorded = interruptWrites(baseline.stateStore, Number.POSITIVE_INFINITY);
      await Effect.runPromise(cycle(baseline.reopen(recorded.store)));
      const totalWrites = recorded.writes();
      expect(totalWrites).toBeGreaterThan(0);

      for (let after = 1; after <= totalWrites; after += 1) {
        const harness = await prepare(root, initial);
        const interrupted = interruptWrites(harness.stateStore, after);
        const result = await Effect.runPromiseExit(cycle(harness.reopen(interrupted.store)));
        expect(Exit.isFailure(result)).toBe(true);
        expect(interrupted.writes()).toBe(after);

        const resumed = harness.reopen();
        const recovery = await Effect.runPromiseExit(
          Effect.gen(function* () {
            const found = yield* resumed.disposalPhase(spec.app);
            // Nothing sessionful survived (or the app is merely active): restart it, then let the plan finish.
            if (found === "absent" || found === "active") {
              yield* resumed.invalidateAppDrain(spec.app);
              yield* resumed.create({ name, spec });
            }
            yield* runDisposalPlan(resumed, yield* resumed.disposalPhase(spec.app));
          }),
        );
        expect(recovery._tag, `${initial}, interrupted after ledger write ${after}`).toBe("Success");
        const bucket = await Effect.runPromise(openLedger(harness.stateStore));
        const final = await Effect.runPromise(bucket.get);
        expect(final?.sessions).toEqual([]);
        expect(final?.appDrains?.map((entry) => entry.phase)).toEqual(["completed"]);
        expect(harness.current()).toEqual([]);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

test.each([1, 2])("direct termination converges after successful ledger write %i", async (after) => {
  const root = await mkdtemp(join(tmpdir(), "lando-mutagen-terminate-"));
  try {
    const harness = await prepare(root, "fresh");
    await Effect.runPromise(harness.client.create({ name, spec }));
    const interrupted = interruptWrites(harness.stateStore, after);
    expect(
      Exit.isFailure(await Effect.runPromiseExit(harness.reopen(interrupted.store).terminate(name))),
    ).toBe(true);
    expect(interrupted.writes()).toBe(after);
    await Effect.runPromise(harness.reopen().terminate(name));
    expect(await Effect.runPromise(harness.reopen().list)).toEqual([]);
    const bucket = await Effect.runPromise(openLedger(harness.stateStore));
    expect((await Effect.runPromise(bucket.get))?.sessions).toEqual([]);
    expect(await Effect.runPromise(harness.reopen().disposalPhase(spec.app))).toBe("absent");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated invalidation refreshes the owned identifiers after session replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-mutagen-invalidate-"));
  try {
    const harness = await prepare(root, "fresh");
    await Effect.runPromise(harness.client.create({ name, spec }));
    await Effect.runPromise(harness.client.invalidateAppDrain(spec.app));
    await Effect.runPromise(harness.client.terminate(name));
    await Effect.runPromise(harness.client.create({ name: "replacement", spec }));

    await Effect.runPromise(harness.reopen().invalidateAppDrain(spec.app));

    const bucket = await Effect.runPromise(openLedger(harness.stateStore));
    expect((await Effect.runPromise(bucket.get))?.appDrains).toEqual([
      { app: spec.app, phase: "invalidated", identifiers: ["sync_New456"] },
    ]);
    expect((await Effect.runPromise(harness.reopen().list)).map((entry) => entry.name)).toEqual([
      "replacement",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
