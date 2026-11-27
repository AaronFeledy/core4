import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withAppDiscovery } from "@lando/landofile/operation-discovery";
import { makeLandoPaths } from "@lando/paths";
import { PluginLoadError } from "@lando/sdk/errors";
import { PathsService } from "@lando/sdk/services";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Scope, Tracer } from "effect";
import { makeAppGenerations } from "../../src/runtime/app-generations.ts";

class GenerationId extends Context.Service<GenerationId, number>()("test/generation-id") {}

const selectionTracer = (selected: Deferred.Deferred<void>) =>
  Tracer.make({
    span(options) {
      return new (class extends Tracer.NativeSpan {
        override end(time: bigint, exit: Exit.Exit<unknown, unknown>) {
          super.end(time, exit);
          if (options.name === "PluginSelection.resolve" && Exit.isSuccess(exit)) {
            Deferred.doneUnsafe(selected, Effect.void);
          }
        }
      })(options);
    },
  });

test.each(["success", "failure", "session close"] as const)(
  "a session-owned build with no remaining waiters reaches %s",
  async (outcome) => {
    const root = await mkdtemp(join(tmpdir(), "lando-generation-build-"));
    try {
      await writeFile(join(root, ".lando.yml"), "name: generation\n");
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* Scope.fork(yield* Effect.scope);
            const constructing = yield* Deferred.make<void>();
            const finishFirst = yield* Deferred.make<void>();
            const closeStarted = yield* Deferred.make<void>();
            const finishClose = yield* Deferred.make<void>();
            const selected = yield* Deferred.make<void>();
            const closed: number[] = [];
            const interrupted: number[] = [];
            let builds = 0;
            const apps = yield* Scope.provide(
              makeAppGenerations({
                policy: {
                  discovery: { bundled: false, system: false, user: false, app: false, disable: [] },
                  manifests: [],
                  externalImports: false,
                },
                host: Context.make(PathsService, makeLandoPaths()),
                build: () =>
                  Layer.effect(
                    GenerationId,
                    Effect.acquireRelease(
                      Effect.sync(() => ++builds),
                      (id) =>
                        Effect.gen(function* () {
                          if (outcome === "failure" && id === 1) {
                            yield* Deferred.succeed(closeStarted, undefined);
                            yield* Deferred.await(finishClose);
                          }
                          closed.push(id);
                        }),
                    ),
                  ),
                project: ({ key, context }) =>
                  Effect.gen(function* () {
                    const id = Context.get(context, GenerationId);
                    if (id === 1) {
                      yield* Deferred.succeed(constructing, undefined);
                      yield* Deferred.await(finishFirst).pipe(
                        Effect.onInterrupt(() =>
                          Effect.sync(() => {
                            interrupted.push(id);
                          }),
                        ),
                      );
                      if (outcome === "failure")
                        return yield* Effect.fail(
                          new PluginLoadError({
                            pluginName: "fixture",
                            message: "first build failed",
                            remediation: "Retry.",
                          }),
                        );
                    }
                    return { key, context: Context.makeUnsafe<unknown>(context.mapUnsafe), id };
                  }),
                refresh: Effect.succeed,
              }),
              session,
            );
            const acquire = Effect.scoped(withAppDiscovery(root, apps.acquire(root)));
            const first = yield* Effect.forkChild(acquire);
            yield* Deferred.await(constructing);
            const second = yield* Effect.forkChild(
              acquire.pipe(Effect.withTracer(selectionTracer(selected)), Effect.withTracerEnabled(true)),
            );
            yield* Deferred.await(selected);
            yield* Effect.yieldNow;
            yield* Fiber.interruptAll([first, second]);
            for (const waiter of [first, second]) {
              const exit = yield* Fiber.await(waiter);
              expect(Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause)).toBe(true);
            }

            switch (outcome) {
              case "success": {
                yield* Deferred.succeed(finishFirst, undefined);
                const next = yield* acquire;
                expect({ generation: next.id, builds, closed }).toEqual({
                  generation: 1,
                  builds: 1,
                  closed: [],
                });
                break;
              }
              case "failure": {
                yield* Deferred.succeed(finishFirst, undefined);
                yield* Deferred.await(closeStarted);
                const retrySelected = yield* Deferred.make<void>();
                const retry = yield* Effect.forkChild(
                  acquire.pipe(
                    Effect.withTracer(selectionTracer(retrySelected)),
                    Effect.withTracerEnabled(true),
                  ),
                );
                yield* Deferred.await(retrySelected);
                yield* Effect.yieldNow;
                yield* Deferred.succeed(finishClose, undefined);
                const next = yield* Fiber.join(retry);
                expect((yield* acquire).id).toBe(2);
                expect({ generation: next.id, builds, closed }).toEqual({
                  generation: 2,
                  builds: 2,
                  closed: [1],
                });
                break;
              }
              case "session close":
                yield* Scope.close(session, Exit.void);
                expect({ builds, interrupted, closed }).toEqual({ builds: 1, interrupted: [1], closed: [1] });
                break;
            }
          }),
        ),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
