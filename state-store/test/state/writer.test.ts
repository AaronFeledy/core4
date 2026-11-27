import { expect, test } from "bun:test";
import { AbsolutePath } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { makePluginStateStore } from "../../src/plugin.ts";
import { makeTestStateStore } from "../../src/testing.ts";
import { lockTestAccess } from "./lock-test-access.ts";

test("plugin writer metadata survives a protected read without changing binary frames", async () => {
  const memory = makeTestStateStore({ writer: "4.14.0" });
  const root = AbsolutePath.make(process.cwd());
  const current = makePluginStateStore(memory.service, root, lockTestAccess);
  const future = makePluginStateStore(memory.service, root, lockTestAccess, { writer: "4.15.0" });
  const spec = { namespace: "writer-test", key: "state.json", schema: Schema.Int, version: 2 };

  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const writer = yield* future.open(spec);
      yield* writer.set(7);
      const reader = yield* current.open({ ...spec, version: 1 });
      const error = yield* Effect.flip(reader.set(0));
      const binary = yield* future.open({ ...spec, key: "binary", codec: "binary" });
      yield* binary.set(7);
      return { error, value: yield* writer.get, bytes: yield* memory.readRaw(binary.path) };
    }),
  );

  expect(result.error).toMatchObject({ reason: "newer-version", writtenBy: "4.15.0" });
  expect(result.error.remediation).toContain("`lando update`");
  expect(result.value).toBe(7);
  expect(result.bytes).toEqual(new Uint8Array([76, 83, 66, 49, 0, 0, 0, 2, 55]));
});

test.each([undefined, 123, "4.15.0\u001b", "x".repeat(65)])(
  "invalid or missing writer %j does not get projected or weaken protection",
  async (writtenBy) => {
    const memory = makeTestStateStore();
    const error = await Effect.runPromise(
      Effect.gen(function* () {
        const bucket = yield* memory.service.open({
          root: { path: AbsolutePath.make(process.cwd()) },
          namespace: "writer-test",
          key: "invalid.json",
          version: 1,
          schema: Schema.Int,
        });
        yield* memory.writeRaw(bucket.path, JSON.stringify({ version: 2, writtenBy, data: 7 }));
        return yield* Effect.flip(bucket.get);
      }),
    );
    expect(error).toMatchObject({ reason: "newer-version", storedVersion: 2 });
    expect(error.writtenBy).toBeUndefined();
  },
);
