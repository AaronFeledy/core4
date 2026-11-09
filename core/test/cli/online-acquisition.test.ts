import { expect, test } from "bun:test";
import { makeTestDownloader } from "@lando/engine/testing/downloader";
import { Context, Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { TestClock } from "effect/testing";

import { McpCommandExecutor } from "@lando/mcp/port";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { RENDERER_CAPABILITIES_NONE } from "@lando/sdk/renderer";
import { EventService, OnlineAcquisition, Renderer } from "@lando/sdk/services";
import { builtInCommandEntries } from "../../src/cli/built-in-command-registry.ts";
import { type CliInvocationSnapshot, runCommandLifecycle } from "../../src/cli/command-lifecycle.ts";
import { makeEventCommandExecutor } from "../../src/cli/event-command-executor.ts";
import { COMMAND_REGISTRY_MANIFEST } from "../../src/cli/generated/command-registry-manifest.ts";
import * as McpExecutor from "../../src/mcp-command-executor.ts";
import { makeTestEventService } from "../../src/testing/test-runtime-events.ts";

const expected = [
  "app:includes:update",
  "app:pull",
  "app:push",
  "app:remote:setup",
  "app:share",
  "apps:init",
  "meta:plugin:add",
  "meta:recipes:describe",
  "meta:recipes:validate",
  "meta:setup",
  "meta:update",
];
const invocation = (commandId: string): CliInvocationSnapshot => ({
  commandId,
  argv: [],
  args: {},
  flags: {},
  cwd: "/workspace/test",
});
const redaction = makeRedactionService();
const layer = Layer.succeed(RedactionService, redaction);
const lifecycle = Effect.fnUntraced(function* <A, E, R>(body: Effect.Effect<A, E, R>, commandId: string) {
  const completed = yield* yield* runCommandLifecycle(body, { invocation: invocation(commandId) });
  return completed.value;
});

test("only the eleven acquisition commands declare onlineAcquisition and project it to the registry", () => {
  expect(
    builtInCommandEntries
      .filter(({ spec }) => spec.onlineAcquisition === true)
      .map(({ spec }) => spec.id)
      .sort(),
  ).toEqual(expected);
  const projected: ReadonlyArray<string> = Object.values(COMMAND_REGISTRY_MANIFEST.commands)
    .filter(({ spec }) => "onlineAcquisition" in spec && spec.onlineAcquisition === true)
    .map(({ spec }) => spec.id)
    .sort();
  expect(projected).toEqual(expected);
});

test.each([
  ["meta:setup", true],
  ["app:start", false],
  ["plugin:download", false],
] as const)(
  "%s provides %s around init, subscriber publication, and command work",
  async (commandId, enabled) => {
    const observed: boolean[] = [];
    const events = makeTestEventService([]);
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const exit = yield* runCommandLifecycle(OnlineAcquisition, {
          invocation: invocation(commandId),
          onInitialized: Effect.gen(function* () {
            observed.push(yield* OnlineAcquisition);
          }),
        });
        const completed = yield* exit;
        return { value: completed.value, after: yield* OnlineAcquisition };
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(EventService, {
          ...events,
          publish: (event) =>
            Effect.gen(function* () {
              observed.push(yield* OnlineAcquisition);
              yield* events.publish(event);
            }),
        }),
      ),
    );
    expect(result).toEqual({ value: enabled, after: false });
    expect(observed).toEqual([enabled, enabled, enabled]);
  },
);

test.each([
  ["app:start", "meta:update", false, true],
  ["meta:setup", "meta:version", true, false],
] as const)(
  "nested event %s -> %s restores its parent's acquisition intent",
  async (parent, child, outer, inner) => {
    const context = Context.make(Context.Service<unknown>("test/runtime"), {}).pipe(
      Context.add(RedactionService, redaction),
      Context.add(Renderer, {
        id: "plain",
        capabilities: RENDERER_CAPABILITIES_NONE,
        message: { info: () => Effect.void, warn: () => Effect.void, error: () => Effect.void },
        output: { stdout: () => Effect.void, stderr: () => Effect.void },
      }),
    );
    const observed: boolean[] = [];
    const executor = makeEventCommandExecutor(context, [
      {
        spec: {
          id: child,
          namespace: "meta",
          summary: "Context witness",
          bootstrap: "none",
          resultSchema: Schema.Boolean,
          run: () =>
            Effect.gen(function* () {
              const value = yield* OnlineAcquisition;
              observed.push(value);
              return value;
            }),
        },
        status: { kind: "implemented" },
      },
    ]);
    const values = await Effect.runPromise(
      lifecycle(
        Effect.gen(function* () {
          const before = yield* OnlineAcquisition;
          yield* executor.run({
            command: child,
            argv: [],
            args: {},
            flags: {},
            cwd: "/workspace/test",
            silent: true,
          });
          return [before, yield* OnlineAcquisition];
        }),
        parent,
      ).pipe(Effect.provide(layer)),
    );
    expect(values).toEqual([outer, outer]);
    expect(observed).toEqual([inner]);
  },
);

test.each([
  ["meta:update", true],
  ["app:info", false],
] as const)("MCP %s derives its own acquisition intent", async (commandId, enabled) => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const executor = yield* McpCommandExecutor;
      const completed = yield* yield* executor.execute(OnlineAcquisition, {
        commandId,
        argv: [],
        args: {},
        flags: {},
      });
      return completed.value;
    }).pipe(Effect.provide(McpExecutor.layer.pipe(Layer.provide(layer)))),
  );
  expect(result).toBe(enabled);
});

test("overlapping commands on one retained runtime keep their acquisition intent isolated", async () => {
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const left = yield* Deferred.make<void>();
      const right = yield* Deferred.make<void>();
      const acquisition = yield* Effect.forkChild(
        lifecycle(
          Deferred.succeed(left, undefined).pipe(
            Effect.andThen(Deferred.await(right)),
            Effect.andThen(OnlineAcquisition),
          ),
          "meta:setup",
        ),
      );
      const routine = yield* Effect.forkChild(
        lifecycle(
          Deferred.succeed(right, undefined).pipe(
            Effect.andThen(Deferred.await(left)),
            Effect.andThen(OnlineAcquisition),
          ),
          "app:start",
        ),
      );
      return [yield* Fiber.join(acquisition), yield* Fiber.join(routine)];
    }).pipe(Effect.provide(layer)),
  );
  expect(result).toEqual([true, false]);
});

test("concurrent acquisition and routine downloads share a retained Downloader without sharing retry intent", () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const td = yield* makeTestDownloader();
      const acquired = "https://test.invalid/acquired.bin";
      const routine = "https://test.invalid/routine.bin";
      td.serve(acquired, new TextEncoder().encode("artifact"));
      td.failResets(acquired, 1);
      td.failResets(routine, 1);
      const acquisition = yield* Effect.forkChild(
        lifecycle(
          Effect.scoped(td.service.download({ url: acquired, destination: { kind: "memory" } })),
          "meta:setup",
        ),
      );
      yield* td.nextRetry;
      const routineExit = yield* Effect.result(
        lifecycle(
          Effect.scoped(td.service.download({ url: routine, destination: { kind: "memory" } })),
          "app:start",
        ),
      );
      expect(routineExit).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "DownloadFetchError", reason: "connection-reset", attempts: 1 },
      });
      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(acquisition)).sizeBytes).toBe(8);
      expect(td.streamCallCount()).toBe(3);
      expect(
        td
          .events()
          .filter((event) => event._tag === "post-download")
          .map((event) => [event.outcome, event.attempts]),
      ).toEqual([
        ["failure", 1],
        ["success", 2],
      ]);
    }).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())),
  ));
