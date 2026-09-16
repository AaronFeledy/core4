import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, type VolumeIdentity } from "@lando/sdk/schema";
import { StateStore, type StateStoreShape } from "@lando/sdk/services";
import { Effect } from "effect";
import { StateStoreLive } from "../src/service.ts";
import { volumeInitialization } from "../src/volume-initialization.ts";

const identity: VolumeIdentity = {
  coordinationKey: "socket/data",
  nativeName: "data",
  generation: "one",
  ownerRoot: AbsolutePath.make("/owner"),
  origin: "created",
};
const isolated = async (body: (store: StateStoreShape) => Promise<void>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-initialization-"));
  try {
    const live = await Effect.runPromise(StateStore.pipe(Effect.provide(StateStoreLive)));
    const store: StateStoreShape = {
      ...live,
      open: (spec) => live.open({ ...spec, root: { path: AbsolutePath.make(root) } }),
    };
    await body(store);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("a missing record is unknown and cannot be claimed fresh", () =>
  isolated(async (store) => {
    const state = await Effect.runPromise(volumeInitialization(store, identity));
    expect(await Effect.runPromise(state.read)).toBeNull();
    expect(await Effect.runPromise(state.begin("operation"))).toBe(false);
  }));

test("creation is idempotent and stale generation and operation claims cannot mutate refreshed state", () =>
  isolated(async (store) => {
    const first = await Effect.runPromise(volumeInitialization(store, identity));
    expect(await Effect.runPromise(first.recordCreation)).toBe(true);
    expect(await Effect.runPromise(first.begin("first"))).toBe(true);
    expect(await Effect.runPromise(first.recordCreation)).toBe(true);
    expect((await Effect.runPromise(first.read))?.state._tag).toBe("in-progress");
    const next = await Effect.runPromise(volumeInitialization(store, { ...identity, generation: "two" }));
    expect(await Effect.runPromise(next.recordCreation)).toBe(true);
    expect(await Effect.runPromise(first.finish({ operationId: "first", outcome: "seeded" }))).toBe(false);
    expect(await Effect.runPromise(first.finish({ operationId: "first", outcome: "failed" }))).toBe(false);
    expect(await Effect.runPromise(first.begin("stale"))).toBe(false);
    expect((await Effect.runPromise(next.read))?.state._tag).toBe("fresh");
    expect(await Effect.runPromise(first.recordCreation)).toBe(false);
  }));

test("adoption is unknown and never creates freshness", () =>
  isolated(async (store) => {
    const state = await Effect.runPromise(volumeInitialization(store, { ...identity, origin: "adopted" }));
    expect(await Effect.runPromise(state.recordCreation)).toBe(false);
    expect(await Effect.runPromise(state.read)).toBeNull();
    expect(await Effect.runPromise(state.begin("seed"))).toBe(false);
  }));

test("different owners and operation IDs cannot finish an initialization", () =>
  isolated(async (store) => {
    const owner = await Effect.runPromise(volumeInitialization(store, identity));
    await Effect.runPromise(owner.recordCreation);
    await Effect.runPromise(owner.begin("winning-operation"));
    const foreign = await Effect.runPromise(
      volumeInitialization(store, { ...identity, ownerRoot: AbsolutePath.make("/foreign") }),
    );
    expect(await Effect.runPromise(foreign.recordCreation)).toBe(false);
    expect(
      await Effect.runPromise(foreign.finish({ operationId: "winning-operation", outcome: "seeded" })),
    ).toBe(false);
    expect(await Effect.runPromise(owner.finish({ operationId: "other-operation", outcome: "seeded" }))).toBe(
      false,
    );
    expect(
      await Effect.runPromise(owner.finish({ operationId: "winning-operation", outcome: "failed" })),
    ).toBe(true);
    expect((await Effect.runPromise(owner.read))?.state._tag).toBe("failed");
  }));
test("concurrent claims admit exactly one operation", () =>
  isolated(async (store) => {
    const state = await Effect.runPromise(volumeInitialization(store, identity));
    await Effect.runPromise(state.recordCreation);
    const claims = await Promise.all(["a", "b", "c"].map((id) => Effect.runPromise(state.begin(id))));
    expect(claims.filter(Boolean)).toHaveLength(1);
  }));
