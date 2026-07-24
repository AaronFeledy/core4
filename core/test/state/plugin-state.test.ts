import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

import { Deferred, Effect, Exit, Fiber, Option, Schema } from "effect";

import { StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath, type AbsolutePath as AbsolutePathType } from "@lando/sdk/schema";

import type { PluginStateBucketSpec } from "../../src/plugins/context-state.ts";
import { makeLandoPluginContext } from "../../src/plugins/context.ts";
import { makeStateStore } from "../../src/state/service.ts";
import { makeTestManagedFileStore } from "../../src/testing/managed-file.ts";

const Doc = Schema.Struct({ count: Schema.Number, label: Schema.String });
type Doc = typeof Doc.Type;

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> =>
  Effect.runPromise(Effect.scoped(effect));

const failure = async <A, E>(effect: Effect.Effect<A, E, never>): Promise<StateStoreError> => {
  const exit = await Effect.runPromiseExit(Effect.scoped(effect));
  if (Exit.isFailure(exit) && exit.cause._tag === "Fail" && exit.cause.error instanceof StateStoreError) {
    return exit.cause.error;
  }
  throw new Error(`expected a StateStoreError failure, got ${JSON.stringify(exit)}`);
};

const absolute = (path: string): AbsolutePathType => Schema.decodeUnknownSync(AbsolutePath)(path);

let userDataRoot: AbsolutePathType;

beforeEach(async () => {
  userDataRoot = absolute(await mkdtemp(join(tmpdir(), "lando-plugin-state-")));
});

afterEach(async () => {
  await rm(userDataRoot, { recursive: true, force: true });
});

const pluginStateRoot = (id: string): AbsolutePathType => absolute(join(userDataRoot, "plugins", id));

const ensurePluginStateRoot = async (id: string): Promise<AbsolutePathType> => {
  const root = pluginStateRoot(id);
  await mkdir(root, { recursive: true });
  return root;
};

const makeContext = async (id: string) =>
  makeLandoPluginContext({
    id,
    managedFileService: (await run(makeTestManagedFileStore())).service,
    stateStore: makeStateStore(),
    pluginStateRoot: await ensurePluginStateRoot(id),
  });

const spec = (
  overrides: { readonly namespace?: string; readonly key?: string; readonly default?: Doc } = {},
): PluginStateBucketSpec<Doc, Doc> => ({
  ...(overrides.namespace === undefined ? {} : { namespace: overrides.namespace }),
  key: overrides.key ?? "doc.json",
  schema: Doc,
  version: 1,
  ...(overrides.default === undefined ? {} : { default: overrides.default }),
});

describe("LandoPluginContext stateStore scoping", () => {
  test("a plugin advisory lock serializes concurrent critical sections", async () => {
    const plugin = await makeContext("plugin-a");

    const secondEnteredWhileFirstHeld = await run(
      Effect.gen(function* () {
        const firstEntered = yield* Deferred.make<void>();
        const releaseFirst = yield* Deferred.make<void>();
        const secondEntered = yield* Deferred.make<void>();
        const first = yield* Effect.fork(
          plugin.stateStore.withLock(
            "runtime-launch",
            Deferred.succeed(firstEntered, undefined).pipe(Effect.zipRight(Deferred.await(releaseFirst))),
          ),
        );
        yield* Deferred.await(firstEntered);
        const second = yield* Effect.fork(
          plugin.stateStore.withLock("runtime-launch", Deferred.succeed(secondEntered, undefined)),
        );
        yield* Effect.yieldNow();
        const observed = yield* Deferred.poll(secondEntered);
        yield* Deferred.succeed(releaseFirst, undefined);
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        return Option.isSome(observed);
      }),
    );

    expect(secondEnteredWhileFirstHeld).toBe(false);
  });

  test("a plugin advisory lock rejects a traversal key", async () => {
    const plugin = await makeContext("plugin-a");

    const error = await failure(plugin.stateStore.withLock("../runtime-launch", Effect.void));

    expect(error.reason).toBe("path");
  });

  test("a plugin reads and writes durable state inside its own subtree", async () => {
    const plugin = await makeContext("plugin-a");

    const result = await run(
      Effect.gen(function* () {
        const bucket = yield* plugin.stateStore.open(spec({ namespace: "bucket" }));
        yield* bucket.set({ count: 1, label: "plugin-a" });
        return { path: bucket.path, value: yield* bucket.get } as const;
      }),
    );

    expect(result.value).toEqual({ count: 1, label: "plugin-a" });
    expect(result.path.startsWith(`${join(userDataRoot, "plugins", "plugin-a")}${sep}`)).toBe(true);
  });

  test("a caller-supplied root is rejected", async () => {
    const plugin = await makeContext("plugin-a");
    const unsafeSpec = { ...spec(), root: { path: absolute("/tmp/evil") } };

    const error = await failure(plugin.stateStore.open(unsafeSpec));

    expect(error.reason).toBe("path");
  });

  test("a key with separators or traversal is rejected", async () => {
    const plugin = await makeContext("plugin-a");

    const error = await failure(plugin.stateStore.open(spec({ key: "../escape.json" })));

    expect(error.reason).toBe("path");
  });

  test("a namespace with separators or traversal is rejected", async () => {
    const plugin = await makeContext("plugin-a");

    const error = await failure(plugin.stateStore.open(spec({ namespace: "../up" })));

    expect(error.reason).toBe("path");
  });

  test("distinct plugin ids cannot see each other's bucket", async () => {
    const stateStore = makeStateStore();
    const managedFileService = (await run(makeTestManagedFileStore())).service;
    const pluginA = makeLandoPluginContext({
      id: "plugin-a",
      managedFileService,
      stateStore,
      pluginStateRoot: await ensurePluginStateRoot("plugin-a"),
    });
    const pluginB = makeLandoPluginContext({
      id: "plugin-b",
      managedFileService,
      stateStore,
      pluginStateRoot: await ensurePluginStateRoot("plugin-b"),
    });

    const result = await run(
      Effect.gen(function* () {
        const bucketA = yield* pluginA.stateStore.open(spec());
        yield* bucketA.set({ count: 7, label: "plugin-a" });
        const bucketB = yield* pluginB.stateStore.open(spec());
        return { pathA: bucketA.path, pathB: bucketB.path, valueB: yield* bucketB.get } as const;
      }),
    );

    expect(result.pathA).not.toBe(result.pathB);
    expect(result.valueB).toBeNull();
  });

  test("a plugin cannot see core state under the same user data root", async () => {
    const stateStore = makeStateStore();
    const plugin = makeLandoPluginContext({
      id: "plugin-a",
      managedFileService: (await run(makeTestManagedFileStore())).service,
      stateStore,
      pluginStateRoot: await ensurePluginStateRoot("plugin-a"),
    });

    const result = await run(
      Effect.gen(function* () {
        const coreBucket = yield* stateStore.open({
          root: { path: userDataRoot },
          key: "doc.json",
          schema: Doc,
          version: 1,
        });
        yield* coreBucket.set({ count: 99, label: "core" });
        const pluginBucket = yield* plugin.stateStore.open(spec());
        return {
          corePath: coreBucket.path,
          pluginPath: pluginBucket.path,
          pluginValue: yield* pluginBucket.get,
        } as const;
      }),
    );

    expect(result.corePath).not.toBe(result.pluginPath);
    expect(result.pluginValue).toBeNull();
  });
});
