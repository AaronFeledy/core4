/**
 * Confirms `StateStore` is wired into core's `minimal` bootstrap layer.
 * Bucket-level behavior (codecs, corruption, locking) is covered by
 * `@lando/state-store`'s own test suite; this file only proves the core
 * runtime composition resolves the service.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { AbsolutePath, type AbsolutePath as AbsolutePathType } from "@lando/sdk/schema";
import { type StateBucketSpec, StateStore } from "@lando/sdk/services";

import { makeLandoRuntime } from "../../src/runtime/layer.ts";

const Doc = Schema.Struct({ count: Schema.Number, label: Schema.String });
type Doc = typeof Doc.Type;

let dir: AbsolutePathType;

beforeEach(async () => {
  dir = Schema.decodeUnknownSync(AbsolutePath)(await mkdtemp(join(tmpdir(), "lando-state-")));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const jsonSpec = (overrides: Partial<StateBucketSpec<Doc, Doc>> = {}): StateBucketSpec<Doc, Doc> => ({
  root: { path: dir },
  key: "doc.json",
  schema: Doc,
  version: 1,
  ...overrides,
});

describe("StateStore — minimal bootstrap availability", () => {
  test("StateStore is yielded from the minimal bootstrap layer and round-trips a bucket", async () => {
    const value = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* StateStore;
        const bucket = yield* svc.open(jsonSpec());
        yield* bucket.set({ count: 42, label: "boot" });
        return yield* bucket.get;
      }).pipe(Effect.provide(makeLandoRuntime({ bootstrap: "minimal" })), Effect.scoped),
    );
    expect(value).toEqual({ count: 42, label: "boot" });
  });
});
