import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withAppDiscovery } from "@lando/landofile/operation-discovery";
import { makeLandoPaths } from "@lando/paths";
import { PluginLoadError } from "@lando/sdk/errors";
import { PathsService } from "@lando/sdk/services";
import { Context, Deferred, Effect, Exit, Fiber, Layer, Scope } from "effect";

import { loadInstalledPlugin } from "../../src/plugins/installed-plugin-loader.ts";
import { registerPluginReloadDrain } from "../../src/plugins/module-cache.ts";
import { makeAppGenerations } from "../../src/runtime/app-generations.ts";

class Value extends Context.Service<Value, { readonly value: unknown }>()("test/generation-value") {}

const fixture = async (
  run: (input: {
    readonly root: string;
    readonly a: string;
    readonly b: string;
    readonly plugin: string;
    readonly user: string;
  }) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "lando-generations-"));
  const plugin = join(root, "plugin");
  const user = join(root, "user-plugins");
  const a = join(root, "a");
  const b = join(root, "b");
  try {
    for (const path of [plugin, user, a, b]) await mkdir(path);
    for (const path of [a, b]) await writeFile(join(path, ".lando.yml"), "name: generation\n");
    await writeFile(
      join(plugin, "package.json"),
      JSON.stringify({
        landoPlugin: { name: "@example/shared", version: "1.0.0", api: 4, entry: "index.ts" },
      }),
    );
    await writeFile(join(plugin, "index.ts"), 'export const value = "before";');
    await writeFile(
      join(user, "registry.json"),
      JSON.stringify({ "@example/shared": { name: "@example/shared", version: "1.0.0", path: plugin } }),
    );
    await run({ root, a, b, plugin, user });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const manager = (
  input: { readonly root: string; readonly plugin: string; readonly user: string },
  resource: Layer.Layer<never> = Layer.empty,
) =>
  makeAppGenerations({
    policy: {
      discovery: { bundled: false, system: false, user: true, app: false, disable: [] },
      manifests: [],
      externalImports: true,
    },
    host: Context.make(PathsService, { ...makeLandoPaths(), pluginsDir: input.user }),
    build: () =>
      Layer.merge(
        resource,
        Layer.effect(
          Value,
          Effect.tryPromise({
            try: async () => ({ value: (await loadInstalledPlugin(input.plugin)).module?.value }),
            catch: (cause) =>
              new PluginLoadError({
                pluginName: "@example/shared",
                message: String(cause),
                remediation: "Retry.",
              }),
          }),
        ),
      ),
    project: ({ key, context }) =>
      Effect.succeed({
        key,
        context: Context.makeUnsafe<unknown>(context.mapUnsafe),
        value: Context.get(context, Value).value,
      }),
    refresh: (record) => Effect.succeed(record),
  });

test("shared package reload drains every app lease before eviction", () =>
  fixture(async (input) => {
    const session = await Effect.runPromise(Scope.make());
    const aLease = await Effect.runPromise(Scope.make());
    const bLease = await Effect.runPromise(Scope.make());
    const drained = await Effect.runPromise(Deferred.make<void>());
    const closes: number[] = [];
    const resource = Layer.effectDiscard(
      Effect.acquireRelease(
        Effect.sync(() => closes.length),
        () =>
          Effect.sync(() => {
            closes.push(1);
          }),
      ),
    );
    const apps = await Effect.runPromise(manager(input, resource).pipe(Scope.provide(session)));
    const acquire = (path: string) => withAppDiscovery(path, apps.acquire(path));
    const firstA = await Effect.runPromise(acquire(input.a).pipe(Scope.provide(aLease)));
    const firstB = await Effect.runPromise(acquire(input.b).pipe(Scope.provide(bLease)));
    const unregister = registerPluginReloadDrain(() =>
      Effect.runPromise(Deferred.succeed(drained, undefined)).then(() => undefined),
    );
    try {
      await writeFile(join(input.plugin, "index.ts"), 'export const value = "after";');
      const reload = Effect.scoped(acquire(input.b));
      const fiber = await Effect.runPromise(Effect.forkIn(reload, session));
      await Effect.runPromise(Deferred.await(drained));
      expect(fiber.pollUnsafe()).toBeUndefined();
      expect(closes).toEqual([]);
      await Effect.runPromise(Scope.close(aLease, Exit.void));
      await Effect.runPromise(Scope.close(bLease, Exit.void));
      const rebuilt = await Effect.runPromise(Fiber.join(fiber));
      expect([firstA.value, firstB.value, rebuilt.value]).toEqual(["before", "before", "after"]);
      expect(closes).toEqual([1, 1]);
      const other = await Effect.runPromise(Effect.scoped(acquire(input.a)));
      expect(other.value).toBe("after");
    } finally {
      unregister();
      await Effect.runPromise(Scope.close(aLease, Exit.void));
      await Effect.runPromise(Scope.close(bLease, Exit.void));
      await Effect.runPromise(Scope.close(session, Exit.void));
    }
  }));

test(
  "fifty sequential reloads close every superseded scope and session scope",
  () =>
    fixture(async (input) => {
      let opened = 0;
      let closed = 0;
      const resource = Layer.effectDiscard(
        Effect.acquireRelease(
          Effect.sync(() => {
            opened++;
          }),
          () =>
            Effect.sync(() => {
              closed++;
            }),
        ),
      );
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const apps = yield* manager(input, resource);
            for (let index = 0; index <= 50; index++) {
              if (index > 0)
                yield* Effect.promise(() =>
                  writeFile(join(input.plugin, "index.ts"), `export const value = ${index};`),
                );
              const record = yield* Effect.scoped(withAppDiscovery(input.a, apps.acquire(input.a)));
              expect(record.value).toBe(index === 0 ? "before" : index);
              expect(opened - closed).toBe(1);
            }
          }),
        ),
      );
      expect(opened).toBe(51);
      expect(closed).toBe(51);
    }),
  30_000,
);

test("concurrent callers share one build and failures are never cached", () =>
  fixture(async (input) => {
    let builds = 0;
    const resource = Layer.effectDiscard(
      Effect.suspend(() => {
        builds++;
        return builds === 1
          ? Effect.fail(
              new PluginLoadError({ pluginName: "fixture", message: "first build", remediation: "Retry." }),
            )
          : Effect.void;
      }),
    );
    const policy = {
      discovery: { bundled: false, system: false, user: false, app: false, disable: [] },
      manifests: [],
      externalImports: false,
    };
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const apps = yield* makeAppGenerations({
            policy,
            host: Context.make(PathsService, makeLandoPaths()),
            build: () => resource,
            project: ({ key, context }) =>
              Effect.succeed({ key, context: Context.makeUnsafe<unknown>(context.mapUnsafe) }),
            refresh: (record) => Effect.succeed(record),
          });
          const acquire = () => withAppDiscovery(input.a, apps.acquire(input.a));
          expect((yield* Effect.result(Effect.scoped(acquire())))._tag).toBe("Failure");
          const records = yield* Effect.all([acquire(), acquire()], { concurrency: 2 });
          expect(records[0]).toBe(records[1]);
          expect(builds).toBe(2);
        }),
      ),
    );
  }));

test.each([false, true])("a package changed during build retries once; continued churn is %s", (continuous) =>
  fixture(async (input) => {
    let builds = 0;
    let closed = 0;
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const apps = yield* makeAppGenerations({
            policy: {
              discovery: { bundled: false, system: false, user: true, app: false, disable: [] },
              manifests: [],
              externalImports: true,
            },
            host: Context.make(PathsService, { ...makeLandoPaths(), pluginsDir: input.user }),
            build: () =>
              Layer.effect(
                Value,
                Effect.gen(function* () {
                  builds++;
                  yield* Effect.addFinalizer(() =>
                    Effect.sync(() => {
                      closed++;
                    }),
                  );
                  const plugin = yield* Effect.promise(() => loadInstalledPlugin(input.plugin));
                  if (continuous || builds === 1)
                    yield* Effect.promise(() =>
                      writeFile(join(input.plugin, "index.ts"), `export const value = ${builds};`),
                    );
                  return { value: plugin.module?.value };
                }),
              ),
            project: ({ key, context }) =>
              Effect.succeed({
                key,
                context: Context.makeUnsafe<unknown>(context.mapUnsafe),
                value: Context.get(context, Value).value,
              }),
            refresh: (record) => Effect.succeed(record),
          });
          const result = yield* Effect.result(
            Effect.scoped(withAppDiscovery(input.a, apps.acquire(input.a))),
          );
          if (continuous)
            expect(result).toMatchObject({
              _tag: "Failure",
              failure: { _tag: "PluginLoadError", remediation: expect.stringContaining("edit settles") },
            });
          else expect(result).toMatchObject({ _tag: "Success", success: { value: 1 } });
          expect(builds).toBe(2);
          expect(closed).toBe(continuous ? 2 : 1);
        }),
      ),
    );
    expect(closed).toBe(2);
  }),
);
