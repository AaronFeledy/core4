import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { WindowsSyncHelperReceipt, changeReceipt, openReceipt } from "../src/windows-sync-helper-receipt.ts";
import { ownerOnlyFileAccess } from "./private-file-access.ts";

const identity = { specDigest: "spec", volumeNonce: "volume", helperNonce: "helper" };
const claimed = { ...identity, phase: "claimed", volumeCreatedAt: null, containerId: null } as const;
const volume = {
  ...identity,
  phase: "volume-created",
  volumeCreatedAt: "created",
  containerId: null,
} as const;
const helper = { ...volume, phase: "helper-created", containerId: "container" } as const;
const removing = { ...helper, phase: "removing" } as const;

const harness = async () => {
  const memory = makeTestStateStore();
  const store = makePluginStateStore(
    memory.service,
    AbsolutePath.make(join(tmpdir(), randomUUID())),
    ownerOnlyFileAccess,
  );
  const bucket = await Effect.runPromise(openReceipt(store, "receipt.json"));
  return { memory, store, bucket };
};

test("receipt operations preserve proofs through creation, reset, and atomic forgetting", async () => {
  const { store, bucket } = await harness();
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      yield* changeReceipt(store, "receipt.json", { operation: "claim", ...identity });
      yield* changeReceipt(store, "receipt.json", { operation: "record-volume", volumeCreatedAt: "created" });
      const created = yield* changeReceipt(store, "receipt.json", {
        operation: "record-helper",
        containerId: "container",
      });
      yield* changeReceipt(store, "receipt.json", { operation: "begin-removal" });
      const reset = yield* changeReceipt(store, "receipt.json", {
        operation: "reset-helper",
        helperNonce: "replacement",
      });
      yield* changeReceipt(store, "receipt.json", { operation: "begin-removal" });
      yield* changeReceipt(store, "receipt.json", { operation: "forget" });
      return { created, reset, final: yield* bucket.get };
    }),
  );
  expect(result).toEqual({ created: helper, reset: { ...volume, helperNonce: "replacement" }, final: null });
});

test.each([
  { current: helper, change: { operation: "claim", ...identity } as const },
  { current: helper, change: { operation: "record-volume", volumeCreatedAt: "other" } as const },
  { current: claimed, change: { operation: "record-helper", containerId: "other" } as const },
  { current: claimed, change: { operation: "begin-removal" } as const },
  { current: helper, change: { operation: "reset-helper", helperNonce: "other" } as const },
  {
    current: claimed,
    change: { operation: "claim", specDigest: "other", volumeNonce: "other", helperNonce: "other" } as const,
  },
  { current: volume, change: { operation: "record-volume", volumeCreatedAt: "other" } as const },
  { current: helper, change: { operation: "record-helper", containerId: "other" } as const },
  { current: volume, change: { operation: "reset-helper", helperNonce: "other" } as const },
])("refuses $change.operation from $current.phase without changing proof", async ({ current, change }) => {
  const { store, bucket } = await harness();
  await Effect.runPromise(bucket.set(current));
  const result = await Effect.runPromise(Effect.result(changeReceipt(store, "receipt.json", change)));
  expect(Result.isFailure(result) && result.failure).toMatchObject({
    _tag: "ProviderUnavailableError",
    operation: "syncHelper.receipt",
    message: expect.stringContaining(`cannot ${change.operation} while ${current.phase}`),
    remediation: expect.stringContaining("Inspect"),
  });
  expect(await Effect.runPromise(bucket.get)).toEqual(current);
});

test("forget refuses a live helper and retains its ownership proof", async () => {
  const { store, bucket } = await harness();
  await Effect.runPromise(bucket.set(helper));
  const result = await Effect.runPromise(
    Effect.result(changeReceipt(store, "receipt.json", { operation: "forget" })),
  );
  expect(Result.isFailure(result) && result.failure).toBeInstanceOf(ProviderUnavailableError);
  expect(await Effect.runPromise(bucket.get)).toEqual(helper);
});

test.each([{ current: removing, change: { operation: "begin-removal" } as const }])(
  "settled $change.operation preserves the original proof",
  async ({ current, change }) => {
    const { store, bucket } = await harness();
    await Effect.runPromise(bucket.set(current));
    const result = await Effect.runPromise(changeReceipt(store, "receipt.json", change));
    expect(result).toEqual(current);
    expect(await Effect.runPromise(bucket.get)).toEqual(current);
  },
);

test("forget removes an uncreated claim's file and replays absence", async () => {
  const { memory, store, bucket } = await harness();
  await Effect.runPromise(bucket.set(claimed));
  await Effect.runPromise(changeReceipt(store, "receipt.json", { operation: "forget" }));
  expect(await Effect.runPromise(memory.readRaw(bucket.path))).toBeNull();
  expect(await Effect.runPromise(changeReceipt(store, "receipt.json", { operation: "forget" }))).toBeNull();
  expect(await Effect.runPromise(memory.readRaw(bucket.path))).toBeNull();
});

test.each([
  { volumeCreatedAt: null, containerId: null, removing: false, expected: claimed },
  { volumeCreatedAt: "created", containerId: null, expected: volume },
  { volumeCreatedAt: "created", containerId: "container", expected: helper },
  { volumeCreatedAt: "created", containerId: "container", removing: true, expected: removing },
  {
    volumeCreatedAt: "created",
    containerId: null,
    removing: true,
    expected: { ...volume, phase: "removing" },
  },
])("migrates v1 to $expected.phase without losing fingerprints", async ({ expected, ...legacy }) => {
  const { memory, bucket } = await harness();
  await Effect.runPromise(
    memory.writeRaw(bucket.path, JSON.stringify({ version: 1, data: { ...identity, ...legacy } })),
  );
  expect(await Effect.runPromise(bucket.get)).toEqual(expected);
});

test.each([
  { volumeCreatedAt: null, containerId: "container" },
  { volumeCreatedAt: null, containerId: null, removing: true },
  { volumeCreatedAt: "", containerId: null },
  { volumeCreatedAt: "created", containerId: "" },
])("refuses contradictory v1 proof %j and preserves the raw record", async (legacy) => {
  const { memory, store, bucket } = await harness();
  const raw = JSON.stringify({ version: 1, data: { ...identity, ...legacy } });
  await Effect.runPromise(memory.writeRaw(bucket.path, raw));
  const result = await Effect.runPromise(
    Effect.result(changeReceipt(store, "receipt.json", { operation: "begin-removal" })),
  );
  expect(Result.isFailure(result) && result.failure).toMatchObject({
    _tag: "ProviderUnavailableError",
    remediation: expect.stringContaining("Inspect"),
  });
  expect(new TextDecoder().decode((await Effect.runPromise(memory.readRaw(bucket.path))) ?? undefined)).toBe(
    raw,
  );
});

test.each([
  { ...claimed, containerId: "container" },
  { ...volume, volumeCreatedAt: null },
  { ...helper, containerId: null },
  { ...removing, volumeCreatedAt: null },
])("rejects contradictory phase fields %j", (raw) => {
  expect(Result.isFailure(Schema.decodeUnknownResult(WindowsSyncHelperReceipt)(raw))).toBe(true);
});
