import { expect, spyOn, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { withAppDiscovery } from "@lando/landofile/operation-discovery";
import { makeLandoPaths } from "@lando/paths";
import { PathsService } from "@lando/sdk/services";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Scheduler, Scope, Tracer } from "effect";

import { loadInstalledPlugin } from "../../src/plugins/installed-plugin-loader.ts";
import * as ModuleCache from "../../src/plugins/module-cache.ts";
import { makeAppGenerations } from "../../src/runtime/app-generations.ts";

const before = "before";
const after = "changed implementation";

const withPlugin = async (
  run: (fixture: {
    readonly app: string;
    readonly plugin: string;
    readonly entry: string;
    readonly registry: string;
    readonly pluginsDir: string;
  }) => Promise<void>,
) => {
  const root = await mkdtemp(join(tmpdir(), "lando-generation-reload-"));
  const app = join(root, "app");
  const plugin = join(root, "plugin");
  const entry = join(plugin, "index.ts");
  const pluginsDir = join(root, "installed");
  const registry = join(pluginsDir, "registry.json");
  try {
    for (const path of [app, plugin, pluginsDir]) await mkdir(path);
    await writeFile(join(app, ".lando.yml"), "name: generation\n");
    await writeFile(
      join(plugin, "package.json"),
      JSON.stringify({
        landoPlugin: { name: "@example/reload", version: "1.0.0", api: 4, entry: "index.ts" },
      }),
    );
    await writeFile(entry, `export const value = "${before}";`);
    await writeFile(
      registry,
      JSON.stringify({ "@example/reload": { name: "@example/reload", version: "1.0.0", path: plugin } }),
    );
    await run({ app, plugin, entry, registry, pluginsDir });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const importValue = (plugin: string) =>
  Effect.promise(async () => (await loadInstalledPlugin(plugin)).module?.value);

const openGeneration = (
  fixture: { readonly app: string; readonly plugin: string; readonly pluginsDir: string },
  resources: Layer.Layer<never> = Layer.empty,
) =>
  Effect.map(
    makeAppGenerations({
      policy: {
        discovery: { bundled: false, system: false, user: true, app: false, disable: [] },
        manifests: [],
        externalImports: true,
      },
      host: Context.make(PathsService, { ...makeLandoPaths(), pluginsDir: fixture.pluginsDir }),
      build: () => resources,
      project: ({ key, context }) =>
        Effect.map(importValue(fixture.plugin), (value) => ({
          key,
          context: Context.makeUnsafe<unknown>(context.mapUnsafe),
          value,
        })),
      refresh: Effect.succeed,
    }),
    (apps) => withAppDiscovery(fixture.app, apps.acquire(fixture.app)),
  );

test("an acquire paused after selection cannot lease the old generation after reload drains it", () =>
  withPlugin((fixture) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const resumeBorrower = yield* Deferred.make<() => void>();
          const acquire = yield* openGeneration(fixture);
          const first = yield* Effect.scoped(acquire);
          expect(first.value).toBe(before);

          let pauseNext = false;
          let selectionPaused = false;
          const scheduler = new Scheduler.MixedScheduler("async", (task) => {
            if (!pauseNext) {
              queueMicrotask(task);
              return () => undefined;
            }
            pauseNext = false;
            selectionPaused = true;
            Deferred.doneUnsafe(resumeBorrower, Effect.succeed(task));
            return () => undefined;
          });
          const tracer = Tracer.make({
            span(options) {
              return new (class extends Tracer.NativeSpan {
                override end(time: bigint, exit: Exit.Exit<unknown, unknown>) {
                  super.end(time, exit);
                  if (
                    !selectionPaused &&
                    options.name === "PluginSelection.resolve" &&
                    Exit.isSuccess(exit)
                  ) {
                    pauseNext = true;
                  }
                }
              })(options);
            },
          });
          const yieldingScheduler: Scheduler.Scheduler = {
            executionMode: "async",
            makeDispatcher: () => scheduler.makeDispatcher(),
            shouldYield: () => pauseNext,
          };
          const borrower = yield* Effect.forkChild(
            Effect.scoped(acquire).pipe(
              Effect.provideService(Scheduler.Scheduler, yieldingScheduler),
              Effect.withTracer(tracer),
              Effect.withTracerEnabled(true),
            ),
          );
          const resume = yield* Deferred.await(resumeBorrower);
          yield* Effect.gen(function* () {
            yield* Effect.promise(() => writeFile(fixture.entry, `export const value = "${after}";`));
            expect(yield* importValue(fixture.plugin)).toBe(after);
          }).pipe(Effect.ensuring(Effect.sync(resume)));
          expect((yield* Fiber.join(borrower)).value).toBe(after);
        }),
      ),
    ),
  ));

test("session close reclaims superseded scopes without waiting for outstanding borrowers", () =>
  withPlugin((fixture) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const parent = yield* Effect.scope;
          const session = yield* Scope.fork(parent);
          const lease = yield* Scope.fork(parent);
          const closed: number[] = [];
          let builds = 0;
          const resources = Layer.effectDiscard(
            Effect.acquireRelease(
              Effect.sync(() => ++builds),
              (id) =>
                Effect.sync(() => {
                  closed.push(id);
                }),
            ),
          );
          const acquire = yield* openGeneration(fixture, resources).pipe(Scope.provide(session));
          const first = yield* acquire.pipe(Scope.provide(lease));
          yield* Effect.promise(() => appendFile(fixture.registry, "\n"));
          const second = yield* Effect.scoped(acquire);
          expect(second).not.toBe(first);
          expect(closed).toEqual([]);

          yield* Scope.close(session, Exit.void);
          expect([...closed].sort()).toEqual([1, 2]);
          const late = yield* Effect.exit(Effect.scoped(acquire));
          expect(Exit.isFailure(late) && Cause.hasInterruptsOnly(late.cause)).toBe(true);
          yield* Scope.close(lease, Exit.void);
          expect([...closed].sort()).toEqual([1, 2]);
        }),
      ),
    ),
  ));

test("reload waits for a superseded generation's in-progress teardown before eviction", () =>
  withPlugin((fixture) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const closing = yield* Deferred.make<void>();
          const finishClose = yield* Deferred.make<void>();
          const drain = yield* Deferred.make<Promise<void>>();
          const register = ModuleCache.registerPluginReloadDrain;
          const observe = spyOn(ModuleCache, "registerPluginReloadDrain").mockImplementation((callback) =>
            register((previous) => {
              const barrier = callback(previous);
              Deferred.doneUnsafe(drain, Effect.succeed(barrier));
              return barrier;
            }),
          );
          let builds = 0;
          const resources = Layer.effectDiscard(
            Effect.acquireRelease(
              Effect.sync(() => ++builds),
              (id) =>
                id === 1
                  ? Deferred.succeed(closing, undefined).pipe(Effect.andThen(Deferred.await(finishClose)))
                  : Effect.void,
            ),
          );
          const acquire = yield* openGeneration(fixture, resources).pipe(
            Effect.ensuring(Effect.sync(() => observe.mockRestore())),
          );
          const lease = yield* Scope.fork(yield* Effect.scope);
          yield* acquire.pipe(Scope.provide(lease));
          yield* Effect.promise(() => writeFile(fixture.registry, "{}"));
          yield* Effect.scoped(acquire);
          const release = yield* Effect.forkChild(Scope.close(lease, Exit.void));
          yield* Deferred.await(closing);

          const pendingAtBarrier = yield* Effect.gen(function* () {
            yield* Effect.promise(() => writeFile(fixture.entry, `export const value = "${after}";`));
            const reload = yield* Effect.forkChild(importValue(fixture.plugin));
            const barrier = yield* Deferred.await(drain);
            yield* Effect.yieldNow;
            // Race the drain itself; eviction does filesystem work after the barrier.
            const result = yield* Effect.promise(() =>
              Promise.race([barrier.then(() => "drained"), Promise.resolve().then(() => "pending")]),
            );
            yield* Deferred.succeed(finishClose, undefined);
            expect(yield* Fiber.join(reload)).toBe(after);
            return result;
          }).pipe(Effect.ensuring(Deferred.succeed(finishClose, undefined)));
          yield* Fiber.join(release);
          expect(pendingAtBarrier).toBe("pending");
        }),
      ),
    ),
  ));
