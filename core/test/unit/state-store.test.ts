/**
 * `StateStoreLive` / `makeStateStore` durable-store behavior: framed json/binary
 * codecs, custom raw codecs, atomic replace, corruption quarantine/discard/fail,
 * version-mismatch discard/migrator, realpath containment, advisory cross-process
 * locking, and availability at the `minimal` bootstrap layer.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Exit, Schema } from "effect";

import { StateStoreError } from "@lando/sdk/errors";
import { type StateBucketSpec, StateStore } from "@lando/sdk/services";

import { StateStoreLive, makeStateStore } from "../../src/state/service.ts";

const store = makeStateStore();

const run = <A>(effect: Effect.Effect<A, StateStoreError>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));

const runExit = <A>(effect: Effect.Effect<A, StateStoreError>) =>
  Effect.runPromiseExit(Effect.scoped(effect));

const failure = async <A>(effect: Effect.Effect<A, StateStoreError>): Promise<StateStoreError> => {
  const exit = await runExit(effect);
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error instanceof StateStoreError) {
    return exit.cause.error;
  }
  throw new Error(`expected a StateStoreError failure, got ${JSON.stringify(exit)}`);
};

const Doc = Schema.Struct({ count: Schema.Number, label: Schema.String });
type Doc = typeof Doc.Type;

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lando-state-"));
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

describe("StateStore — json bucket round-trip", () => {
  test("set then get round-trips a schema-validated value", async () => {
    const value = await run(
      Effect.gen(function* () {
        const bucket = yield* store.open(jsonSpec());
        yield* bucket.set({ count: 3, label: "hi" });
        return yield* bucket.get;
      }),
    );
    expect(value).toEqual({ count: 3, label: "hi" });
  });

  test("get returns the bucket default (else null) when the file is absent", async () => {
    const [withDefault, withoutDefault] = await run(
      Effect.gen(function* () {
        const a = yield* store.open(jsonSpec({ default: { count: 0, label: "zero" } }));
        const b = yield* store.open(jsonSpec({ key: "missing.json" }));
        return [yield* a.get, yield* b.get] as const;
      }),
    );
    expect(withDefault).toEqual({ count: 0, label: "zero" });
    expect(withoutDefault).toBeNull();
  });

  test("the on-disk format is a { version, data } JSON envelope", async () => {
    await run(
      Effect.gen(function* () {
        const bucket = yield* store.open(jsonSpec());
        yield* bucket.set({ count: 7, label: "env" });
      }),
    );
    const raw = JSON.parse(await readFile(join(dir, "doc.json"), "utf8"));
    expect(raw).toEqual({ version: 1, data: { count: 7, label: "env" } });
  });

  test("update reads the current value and persists/returns the new value", async () => {
    const result = await run(
      Effect.gen(function* () {
        const bucket = yield* store.open(jsonSpec({ default: { count: 0, label: "x" } }));
        const next = yield* bucket.update((cur) => ({ count: (cur?.count ?? 0) + 5, label: "x" }));
        const persisted = yield* bucket.get;
        return { next, persisted } as const;
      }),
    );
    expect(result.next).toEqual({ count: 5, label: "x" });
    expect(result.persisted).toEqual({ count: 5, label: "x" });
  });

  test("modify returns the B result and persists the A value, after the write succeeds", async () => {
    const result = await run(
      Effect.gen(function* () {
        const bucket = yield* store.open(jsonSpec());
        const reported = yield* bucket.modify<string>((cur) => {
          const next: Doc = { count: (cur?.count ?? 0) + 1, label: "m" };
          return [`was-${cur === null ? "absent" : cur.count}`, next];
        });
        const persisted = yield* bucket.get;
        return { reported, persisted } as const;
      }),
    );
    expect(result.reported).toBe("was-absent");
    expect(result.persisted).toEqual({ count: 1, label: "m" });
  });

  test("exists and remove track presence", async () => {
    const states = await run(
      Effect.gen(function* () {
        const bucket = yield* store.open(jsonSpec());
        const before = yield* bucket.exists;
        yield* bucket.set({ count: 1, label: "y" });
        const present = yield* bucket.exists;
        yield* bucket.remove;
        const after = yield* bucket.exists;
        yield* bucket.remove; // removing an absent file is a no-op
        return { before, present, after } as const;
      }),
    );
    expect(states).toEqual({ before: false, present: true, after: false });
  });
});

describe("StateStore — atomic write", () => {
  test("a successful set leaves no temp file behind", async () => {
    await run(
      Effect.gen(function* () {
        const bucket = yield* store.open(jsonSpec());
        yield* bucket.set({ count: 1, label: "a" });
      }),
    );
    const entries = await readdir(dir);
    expect(entries.filter((name) => name.includes(".tmp-"))).toEqual([]);
    expect(entries).toContain("doc.json");
  });
});

describe("StateStore — corruption handling", () => {
  test('onCorrupt "quarantine" renames the bad file and returns the default', async () => {
    await writeFile(join(dir, "doc.json"), "{ this is not json");
    const value = await run(
      Effect.gen(function* () {
        const bucket = yield* store.open(
          jsonSpec({ onCorrupt: "quarantine", default: { count: 9, label: "d" } }),
        );
        return yield* bucket.get;
      }),
    );
    expect(value).toEqual({ count: 9, label: "d" });
    const entries = await readdir(dir);
    expect(entries.some((name) => name.startsWith("doc.json.corrupt-"))).toBe(true);
    expect(entries).not.toContain("doc.json");
  });

  test('onCorrupt "discard" returns the default without quarantining', async () => {
    await writeFile(join(dir, "doc.json"), "garbage");
    const value = await run(
      Effect.gen(function* () {
        const bucket = yield* store.open(
          jsonSpec({ onCorrupt: "discard", default: { count: 0, label: "z" } }),
        );
        return yield* bucket.get;
      }),
    );
    expect(value).toEqual({ count: 0, label: "z" });
    const entries = await readdir(dir);
    expect(entries).toContain("doc.json");
    expect(entries.some((name) => name.startsWith("doc.json.corrupt-"))).toBe(false);
  });

  test('onCorrupt "fail" surfaces a StateStoreError with reason "decode"', async () => {
    await writeFile(join(dir, "doc.json"), "not-json-at-all");
    const error = await failure(
      Effect.gen(function* () {
        const bucket = yield* store.open(jsonSpec({ onCorrupt: "fail" }));
        return yield* bucket.get;
      }),
    );
    expect(error.reason).toBe("decode");
    expect(error.operation).toBe("get");
  });

  test("a schema-invalid payload is treated as corruption", async () => {
    await writeFile(join(dir, "doc.json"), JSON.stringify({ version: 1, data: { count: "nope" } }));
    const error = await failure(
      Effect.gen(function* () {
        const bucket = yield* store.open(jsonSpec({ onCorrupt: "fail" }));
        return yield* bucket.get;
      }),
    );
    expect(error.reason).toBe("decode");
  });
});

describe("StateStore — version mismatch", () => {
  test('onVersionMismatch "discard" returns the default for an older on-disk version', async () => {
    await writeFile(join(dir, "doc.json"), JSON.stringify({ version: 1, data: { count: 1, label: "old" } }));
    const value = await run(
      Effect.gen(function* () {
        const bucket = yield* store.open(
          jsonSpec({ version: 2, onVersionMismatch: "discard", default: { count: 0, label: "new" } }),
        );
        return yield* bucket.get;
      }),
    );
    expect(value).toEqual({ count: 0, label: "new" });
  });

  test("a StateMigrator upgrades an older payload with its source version", async () => {
    await writeFile(join(dir, "doc.json"), JSON.stringify({ version: 1, data: { n: 4 } }));
    const value = await run(
      Effect.gen(function* () {
        const bucket = yield* store.open(
          jsonSpec({
            version: 2,
            onVersionMismatch: (raw, fromVersion) => {
              const legacy = raw as { n: number };
              return { count: legacy.n, label: `from-v${fromVersion}` };
            },
          }),
        );
        return yield* bucket.get;
      }),
    );
    expect(value).toEqual({ count: 4, label: "from-v1" });
  });

  test('a throwing migrator surfaces reason "version"', async () => {
    await writeFile(join(dir, "doc.json"), JSON.stringify({ version: 1, data: { n: 4 } }));
    const error = await failure(
      Effect.gen(function* () {
        const bucket = yield* store.open(
          jsonSpec({
            version: 2,
            onVersionMismatch: () => {
              throw new Error("cannot migrate");
            },
          }),
        );
        return yield* bucket.get;
      }),
    );
    expect(error.reason).toBe("version");
  });
});

describe("StateStore — binary codec", () => {
  test("set/get round-trips through the magic-header binary envelope", async () => {
    const value = await run(
      Effect.gen(function* () {
        const bucket = yield* store.open(jsonSpec({ key: "doc.bin", codec: "binary" }));
        yield* bucket.set({ count: 11, label: "bin" });
        return yield* bucket.get;
      }),
    );
    expect(value).toEqual({ count: 11, label: "bin" });
    const bytes = await readFile(join(dir, "doc.bin"));
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x4c, 0x53, 0x42, 0x31]); // "LSB1"
  });
});

describe("StateStore — custom raw codec", () => {
  const Line = Schema.Struct({ value: Schema.String });
  type Line = typeof Line.Type;

  const customSpec = (): StateBucketSpec<Line, Line> => ({
    root: { path: dir },
    key: "raw.txt",
    schema: Line,
    version: 1,
    codec: {
      encode: (a: Line) => `LANDO-RAW\n${a.value}\n`,
      decode: (raw: Uint8Array) => {
        const text = new TextDecoder().decode(raw);
        const line = text.split("\n")[1] ?? "";
        return { value: line };
      },
    },
  });

  test("preserves the user-facing on-disk format byte-for-byte (no envelope frame)", async () => {
    const value = await run(
      Effect.gen(function* () {
        const bucket = yield* store.open(customSpec());
        yield* bucket.set({ value: "hello" });
        return yield* bucket.get;
      }),
    );
    expect(value).toEqual({ value: "hello" });
    const onDisk = await readFile(join(dir, "raw.txt"), "utf8");
    expect(onDisk).toBe("LANDO-RAW\nhello\n");
  });

  test("a version bump never triggers migration for a custom (unversioned) codec", async () => {
    await writeFile(join(dir, "raw.txt"), "LANDO-RAW\npreexisting\n");
    const value = await run(
      Effect.gen(function* () {
        const bucket = yield* store.open({ ...customSpec(), version: 99 });
        return yield* bucket.get;
      }),
    );
    expect(value).toEqual({ value: "preexisting" });
  });
});

describe("StateStore — path containment", () => {
  test('a key with a path separator fails with reason "path"', async () => {
    const error = await failure(store.open(jsonSpec({ key: "../escape.json" })));
    expect(error.reason).toBe("path");
    expect(error.operation).toBe("open");
  });

  test('a namespace with a path separator fails with reason "path"', async () => {
    const error = await failure(store.open(jsonSpec({ namespace: "../up", key: "doc.json" })));
    expect(error.reason).toBe("path");
  });

  test("a symlinked directory escaping the root is rejected", async () => {
    const outside = await mkdtemp(join(tmpdir(), "lando-outside-"));
    try {
      // `<root>/link` -> `<outside>`; `<root>/link` is a contained name but its
      // realpath escapes the root, so resolving a bucket under it must fail.
      await symlink(outside, join(dir, "link"));
      const error = await failure(store.open(jsonSpec({ namespace: "link", key: "doc.json" })));
      expect(error.reason).toBe("path");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  test("a namespaced bucket inside the root resolves and round-trips", async () => {
    const value = await run(
      Effect.gen(function* () {
        const bucket = yield* store.open(jsonSpec({ namespace: "ns", key: "doc.json" }));
        yield* bucket.set({ count: 2, label: "ns" });
        return yield* bucket.get;
      }),
    );
    expect(value).toEqual({ count: 2, label: "ns" });
    expect(await readFile(join(dir, "ns", "doc.json"), "utf8")).toContain('"count": 2');
  });
});

describe("StateStore — advisory lock", () => {
  test("an advisory bucket serializes concurrent updates without losing a write", async () => {
    await run(
      Effect.gen(function* () {
        const bucket = yield* store.open(jsonSpec({ lock: "advisory", default: { count: 0, label: "c" } }));
        // 20 concurrent increments must all land (serialized RMW).
        yield* Effect.all(
          Array.from({ length: 20 }, () =>
            bucket.update((cur) => ({ count: (cur?.count ?? 0) + 1, label: "c" })),
          ),
          { concurrency: "unbounded" },
        );
      }),
    );
    const raw = JSON.parse(await readFile(join(dir, "doc.json"), "utf8"));
    expect(raw.data.count).toBe(20);
  });

  test("a none-locked bucket creates no lockfile", async () => {
    await run(
      Effect.gen(function* () {
        const bucket = yield* store.open(jsonSpec({ lock: "none" }));
        yield* bucket.update((cur) => ({ count: (cur?.count ?? 0) + 1, label: "n" }));
      }),
    );
    const entries = await readdir(dir);
    expect(entries.some((name) => name.endsWith(".lock"))).toBe(false);
  });

  test("an advisory bucket releases its lock after each operation", async () => {
    await run(
      Effect.gen(function* () {
        const bucket = yield* store.open(jsonSpec({ lock: "advisory" }));
        yield* bucket.set({ count: 1, label: "r" });
      }),
    );
    const entries = await readdir(dir);
    expect(entries.some((name) => name.endsWith(".lock"))).toBe(false);
  });
});

describe("StateStore — minimal bootstrap availability", () => {
  test("StateStore is yielded from StateStoreLive and round-trips a bucket", async () => {
    const value = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const svc = yield* StateStore;
          const bucket = yield* svc.open(jsonSpec());
          yield* bucket.set({ count: 42, label: "boot" });
          return yield* bucket.get;
        }),
      ).pipe(Effect.provide(StateStoreLive)),
    );
    expect(value).toEqual({ count: 42, label: "boot" });
  });
});
