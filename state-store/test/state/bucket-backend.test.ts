import { expect, test } from "bun:test";
import type { StateStoreError } from "@lando/sdk/errors";
import type { StateBucketSpec } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { type StateBucketBackend, buildStateBucket } from "../../src/bucket.ts";

const file = "/state/bucket.json";
const spec: StateBucketSpec<number, number> = {
  root: "userData",
  key: "bucket.json",
  schema: Schema.Number,
  version: 2,
  default: 9,
};
const bytes = (text: string) => new TextEncoder().encode(text);
const recordingBackend = (raw: Uint8Array | null = null) => {
  const calls: unknown[] = [];
  const backend: StateBucketBackend = {
    readBytes: (path, operation) =>
      Effect.sync(() => {
        calls.push(["read", path, operation]);
        return raw;
      }),
    writeBytes: (path, body, operation, options) =>
      Effect.sync(() => {
        calls.push(["write", path, body, operation, options]);
      }),
    remove: (path) =>
      Effect.sync(() => {
        calls.push(["remove", path]);
      }),
    exists: (path) =>
      Effect.sync(() => {
        calls.push(["exists", path]);
        return raw !== null;
      }),
    quarantine: (path, now) =>
      Effect.sync(() => {
        calls.push(["quarantine", path, now]);
      }),
    withLock: (path, operation, body) =>
      Effect.sync(() => {
        calls.push(["lock", path, operation]);
      }).pipe(Effect.andThen(body)),
  };
  return { backend, calls };
};

for (const lock of [undefined, "none", "advisory"] as const) {
  for (const operation of ["modify", "update", "set", "remove"] as const) {
    test(`${operation} locks only when advisory mode is selected (${lock})`, async () => {
      // Given an absent bucket with a recording IO backend
      const { backend, calls } = recordingBackend();
      const bucket = buildStateBucket({ ...spec, ...(lock === undefined ? {} : { lock }) }, file, backend);
      const actions: Record<typeof operation, Effect.Effect<unknown, StateStoreError>> = {
        modify: bucket.modify((current) => ["result", (current ?? 0) + 1]),
        update: bucket.update((current) => (current ?? 0) + 1),
        set: bucket.set(10),
        remove: bucket.remove,
      };
      // When one mutation runs
      const result = await Effect.runPromise(actions[operation]);
      // Then the lock encloses the IO and the result follows the mutation contract
      const io =
        operation === "remove"
          ? [["remove", file]]
          : [
              ...(operation === "set" ? [] : [["read", file, "get"]]),
              ["write", file, '{\n  "version": 2,\n  "data": 10\n}\n', "set", {}],
            ];
      expect(calls).toEqual([...(lock === "advisory" ? [["lock", file, operation]] : []), ...io]);
      expect(result).toBe(operation === "modify" ? "result" : operation === "update" ? 10 : undefined);
    });
  }
}

for (const onCorrupt of ["quarantine", "discard", "fail"] as const) {
  for (const raw of ["broken", '{"version":2,"data":"invalid"}']) {
    test(`handles corrupt bytes with ${onCorrupt} (${raw})`, async () => {
      // Given malformed framing or a schema-invalid payload
      const { backend, calls } = recordingBackend(bytes(raw));
      const bucket = buildStateBucket({ ...spec, onCorrupt }, file, backend);
      // When a read completes
      const result = await Effect.runPromise(
        Effect.result(bucket.get).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              calls.push("completed");
            }),
          ),
        ),
      );
      // Then quarantine completes before fallback, while discard/fail leave the file alone
      expect(calls).toEqual([
        ["read", file, "get"],
        ...(onCorrupt === "quarantine" ? [["quarantine", file, expect.any(Number)]] : []),
        "completed",
      ]);
      expect(result).toMatchObject(
        onCorrupt === "fail"
          ? { _tag: "Failure", failure: { reason: "decode", operation: "get", path: file } }
          : { _tag: "Success", success: 9 },
      );
    });
  }
}

test("migrates the raw payload when the frame version differs", async () => {
  // Given an old payload that is invalid under the new schema
  const { backend } = recordingBackend(bytes('{"version":1,"data":{"count":4}}'));
  const received: unknown[] = [];
  const bucket = buildStateBucket(
    {
      ...spec,
      onVersionMismatch: (payload, version) => {
        received.push([payload, version]);
        return Schema.decodeUnknownSync(Schema.Struct({ count: Schema.Number }))(payload).count;
      },
    },
    file,
    backend,
  );
  // When reading the old frame
  const result = await Effect.runPromise(bucket.get);
  // Then migration receives the untouched old payload and source version
  expect(result).toBe(4);
  expect(received).toEqual([[{ count: 4 }, 1]]);
});

test("reports a version error when the migrator throws", async () => {
  // Given a failing migrator
  const cause = new Error("migration rejected");
  const { backend } = recordingBackend(bytes('{"version":1,"data":4}'));
  const bucket = buildStateBucket(
    {
      ...spec,
      onVersionMismatch: () => {
        throw cause;
      },
    },
    file,
    backend,
  );
  // When reading a mismatched version
  const result = await Effect.runPromise(Effect.result(bucket.get));
  // Then the failure retains its version classification and original cause
  expect(result).toMatchObject({
    _tag: "Failure",
    failure: { reason: "version", operation: "get", path: file, cause },
  });
});

for (const cause of ["raw cause", new Error("codec rejected")]) {
  test(`preserves production frame-decode cause semantics for ${typeof cause}`, async () => {
    // Given a custom codec that throws an arbitrary value
    const { backend } = recordingBackend(bytes("opaque"));
    const bucket = buildStateBucket(
      {
        ...spec,
        onCorrupt: "fail",
        codec: {
          encode: String,
          decode: () => {
            throw cause;
          },
        },
      },
      file,
      backend,
    );
    // When the frame is decoded
    const result = await Effect.runPromise(Effect.flip(bucket.get));
    // Then Error instances survive and non-Errors gain the production wrapper
    expect(result.reason).toBe("decode");
    if (cause instanceof Error) expect(result.cause).toBe(cause);
    else {
      expect(result.cause).toBeInstanceOf(Error);
      expect(result.cause).toMatchObject({ message: "State codec decode failed.", cause });
    }
  });
}

test("passes explicit permissions when writing custom codec bytes", async () => {
  // Given an unframed codec and private permissions
  const { backend, calls } = recordingBackend();
  const bucket = buildStateBucket(
    { ...spec, mode: 0o600, codec: { encode: String, decode: () => 0 } },
    file,
    backend,
  );
  // When writing a value
  await Effect.runPromise(bucket.set(4));
  // Then the backend receives raw bytes and the original write operation/options
  expect(calls).toEqual([["write", file, "4", "set", { mode: 0o600 }]]);
});
