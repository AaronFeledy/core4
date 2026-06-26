import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { AbsolutePath, type AbsolutePath as AbsolutePathType } from "@lando/sdk/schema";
import { type StateStoreContractHarness, runStateStoreContract } from "@lando/sdk/test";

import { makeStateStore } from "../../src/state/service.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

let root: AbsolutePathType;

beforeEach(async () => {
  root = Schema.decodeUnknownSync(AbsolutePath)(await mkdtemp(join(tmpdir(), "lando-state-contract-")));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const readRaw = (file: AbsolutePathType): Effect.Effect<Uint8Array | null> =>
  Effect.promise(async () => {
    try {
      return new Uint8Array(await readFile(file));
    } catch {
      return null;
    }
  });

const writeRaw = (file: AbsolutePathType, bytes: Uint8Array | string): Effect.Effect<void> =>
  Effect.promise(() => writeFile(file, bytes));

const list = (dir: AbsolutePathType): Effect.Effect<ReadonlyArray<string>> =>
  Effect.promise(() => readdir(dir));

const plantStaleLock = (file: AbsolutePathType): Effect.Effect<void> =>
  Effect.promise(async () => {
    const target = await realpath(file);
    await writeFile(`${target}.lock`, JSON.stringify({ pid: 2147483646, token: "stale", createdAt: 0 }));
  });

describe("StateStore contract suite", () => {
  test("StateStoreLive satisfies the StateStore contract", async () => {
    const harness: StateStoreContractHarness = {
      name: "StateStoreLive",
      store: makeStateStore(),
      root,
      readRaw,
      list,
      writeRaw,
      plantStaleLock,
    };

    const result = await Effect.runPromise(Effect.scoped(runStateStoreContract(harness)));
    expect(result).toBeUndefined();
  });

  test("TestStateStore satisfies the StateStore contract", async () => {
    const testStore = makeTestStateStore();
    const harness: StateStoreContractHarness = {
      name: "TestStateStore",
      store: testStore.service,
      root,
      readRaw: testStore.readRaw,
      list: testStore.list,
      writeRaw: testStore.writeRaw,
    };

    const result = await Effect.runPromise(Effect.scoped(runStateStoreContract(harness)));
    expect(result).toBeUndefined();
  });
});
