import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AbsolutePath } from "@lando/sdk/schema";
import type { CacheStateBucketSpec } from "@lando/sdk/services";
import { Effect, Schema } from "effect";

import { makeStateStore } from "../../src/service.ts";
import { makeTestStateStore } from "../../src/testing.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

for (const backend of ["disk", "memory"] as const) {
  for (const violation of ["default", "onCorrupt", "onVersionMismatch"] as const) {
    test(`${backend} rejects a JavaScript cache spec violating ${violation} at open`, async () => {
      const store =
        backend === "disk"
          ? makeStateStore({ privateFileAccess: ownerOnlyFileAccess })
          : makeTestStateStore().service;
      const spec: CacheStateBucketSpec<number, number> = {
        root: "userCache",
        key: "cache.json",
        schema: Schema.Number,
        version: 1,
        default: 0,
      };
      if (violation === "default") Reflect.deleteProperty(spec, "default");
      else Reflect.set(spec, violation, violation === "onCorrupt" ? "fail" : () => 0);

      const result = await Effect.runPromise(Effect.result(store.open(spec)));

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "StateStoreError", reason: "decode", operation: "open" },
      });
    });
  }

  test(`${backend} accepts a regenerable cache and returns its default after removal`, async () => {
    const root = AbsolutePath.make(await mkdtemp(join(tmpdir(), "lando-cache-spec-")));
    try {
      const store =
        backend === "disk"
          ? makeStateStore({
              privateFileAccess: ownerOnlyFileAccess,
              roots: { userDataRoot: root, userCacheRoot: root, userConfRoot: root, systemPluginRoot: root },
            })
          : makeTestStateStore().service;
      const value = await Effect.runPromise(
        Effect.gen(function* () {
          const bucket = yield* store.open({
            root: "userCache",
            key: "regenerable.json",
            schema: Schema.Number,
            version: 1,
            default: 0,
            onCorrupt: "quarantine",
            onVersionMismatch: "discard",
          });
          yield* bucket.set(7);
          yield* bucket.remove;
          return yield* bucket.get;
        }),
      );
      expect(value).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
}
