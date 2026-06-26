import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema } from "effect";

import { AbsolutePath, type AbsolutePath as AbsolutePathType } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";

import { makeLandoRuntime } from "../../src/runtime/layer.ts";

const HostDoc = Schema.Struct({ count: Schema.Number, label: Schema.String });

let tmpRoot: AbsolutePathType | undefined;

afterEach(async () => {
  if (tmpRoot !== undefined) {
    await rm(tmpRoot, { recursive: true, force: true });
    tmpRoot = undefined;
  }
});

describe("StateStore host runtime access", () => {
  test("a host opens, writes, and re-reads a bucket under an isolated path root", async () => {
    tmpRoot = Schema.decodeUnknownSync(AbsolutePath)(await mkdtemp(join(tmpdir(), "lando-host-state-")));
    const dataDir = Schema.decodeUnknownSync(AbsolutePath)(join(tmpRoot, "data"));
    const isolatedDir = Schema.decodeUnknownSync(AbsolutePath)(join(tmpRoot, "iso"));
    const value = { count: 315, label: "host-state" };

    await mkdir(isolatedDir, { recursive: true });

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* StateStore;
        const bucket = yield* svc.open({
          root: { path: isolatedDir },
          key: "host.json",
          schema: HostDoc,
          version: 1,
        });
        yield* bucket.set(value);
        return yield* bucket.get;
      }).pipe(
        Effect.provide(
          makeLandoRuntime({
            bootstrap: "minimal",
            config: { userDataRoot: dataDir },
          }),
        ),
        Effect.scoped,
      ),
    );

    expect(result).toEqual(value);
  });
});
