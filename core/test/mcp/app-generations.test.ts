import { afterEach, expect, test } from "bun:test";
import { rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LandoEvent } from "@lando/sdk/events";
import { AbsolutePath, LandofileShape, LoadScopedLandofile } from "@lando/sdk/schema";
import { AppPlanner, EventService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Context, DateTime, Effect, Exit, Layer, Result, Schema, Scope } from "effect";
import "../../src/runtime/bundled-plugins";
import { withAppDiscovery } from "@lando/landofile/operation-discovery";
import {
  type McpAppGenerationRecord,
  type McpAppGenerations,
  makeMcpAppGenerations,
} from "../../src/cli/commands/meta/mcp-app-generations";
import { type LandoGenerationRuntime, makeLandoGenerationRuntime } from "../../src/runtime/layer";
import {
  DELIVERIES_KEY,
  type FixtureApp,
  fixtureDeliveries,
  fixtureRoot,
  lazyCommandSource,
  writeFixtureApp,
} from "./app-fixture";

const roots: string[] = [];
afterEach(async () => {
  Reflect.deleteProperty(globalThis, DELIVERIES_KEY);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const twoApps = async () => {
  const parent = await fixtureRoot("generations");
  roots.push(parent);
  const a = await writeFixtureApp(parent, "a", { commands: ["fixture:shared"], serviceType: "a-thing" });
  const b = await writeFixtureApp(parent, "b", {
    commands: ["fixture:shared", "fixture:b-only"],
    serviceType: "b-thing",
  });
  return { a, b };
};

const sessionRuntime = (session: FixtureApp, layers: ReadonlyArray<Layer.Layer<never>> = []) =>
  Result.getOrThrow(
    makeLandoGenerationRuntime({
      bootstrap: "app",
      cwd: session.root,
      interaction: "non-interactive",
      plugins: { policy: "discovery", layers },
    }),
  );

/** Open a session host and its generation manager inside the surrounding scope. */
const openSession = Effect.fnUntraced(function* (runtime: LandoGenerationRuntime) {
  const host = yield* Layer.build(runtime.host);
  return yield* makeMcpAppGenerations({ runtime, host, sessionIds: new Set() });
});

/** One call's acquisition, with its own discovery memo. */
const acquireIn = (apps: McpAppGenerations, directory: string) =>
  withAppDiscovery(directory, apps.acquire(directory));

const plan = (generation: McpAppGenerationRecord, app: FixtureApp, type: string) =>
  Context.get(generation.context, AppPlanner).plan(
    LoadScopedLandofile.make({
      stage: "load-scoped",
      document: Schema.decodeUnknownSync(LandofileShape)({
        name: "generation-plan",
        router: { enabled: false },
        services: { web: { type, image: "alpine", home: false } },
      }),
      pendingSites: [],
      context: { appRoot: AbsolutePath.make(app.root), env: {} },
    }),
    TestRuntimeProvider.capabilities,
  );

test("each app's generation plans with that app's plugins, and the session app keeps its own", async () => {
  // Given two apps whose app-local plugins contribute different service types
  const { a, b } = await twoApps();

  const outcome = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const apps = yield* openSession(sessionRuntime(a));
        // When the session app and another app are planned through their own generations
        const generationA = yield* acquireIn(apps, a.root);
        const generationB = yield* acquireIn(apps, b.root);
        return {
          aOwn: yield* Effect.result(plan(generationA, a, "a-thing")),
          aForeign: yield* Effect.result(plan(generationA, a, "b-thing")),
          bOwn: yield* Effect.result(plan(generationB, b, "b-thing")),
          bForeign: yield* Effect.result(plan(generationB, b, "a-thing")),
          planners: [
            Context.get(generationA.context, AppPlanner),
            Context.get(generationB.context, AppPlanner),
          ] as const,
          keys: [generationA.key, generationB.key],
          commands: [[...generationA.commands.keys()], [...generationB.commands.keys()]],
        };
      }),
    ),
  );

  // Then each planner resolves only its own app's service type, from its own planner instance
  expect(outcome.keys).toEqual([a.root, b.root]);
  expect(outcome.aOwn._tag).toBe("Success");
  expect(outcome.bOwn._tag).toBe("Success");
  expect(JSON.stringify(outcome.aForeign)).toContain("Unsupported service type b-thing");
  expect(JSON.stringify(outcome.bForeign)).toContain("Unsupported service type a-thing");
  expect(outcome.planners[0]).not.toBe(outcome.planners[1]);
  expect(outcome.commands[0]).toContain("fixture:shared");
  expect(outcome.commands[0]).not.toContain("fixture:b-only");
  expect(outcome.commands[1]).toContain("fixture:b-only");
}, 30_000);

test("an edited plugin entry builds a new generation and restoring it reloads again", async () => {
  // Given app B's plugin entry already loaded into this session
  const { a, b } = await twoApps();
  const original = await Bun.file(b.entry).text();

  const [loaded, edited, restored] = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const apps = yield* openSession(sessionRuntime(a));
        const first = yield* Effect.scoped(acquireIn(apps, b.root));
        // When the entry changes on disk at the same path, and is later restored
        yield* Effect.promise(() => writeFile(b.entry, `${original}\nexport const edited = true;\n`));
        const stale = yield* Effect.scoped(acquireIn(apps, b.root));
        yield* Effect.promise(() => writeFile(b.entry, original));
        return [first, stale, yield* Effect.scoped(acquireIn(apps, b.root))] as const;
      }),
    ),
  );

  // Then both edits produce fresh projections with the same command owner
  expect(edited).not.toBe(loaded);
  expect(restored).not.toBe(edited);
  expect(edited.commands.get("fixture:shared")?._tag).toBe("Eligible");
  expect(restored.commands.get("fixture:shared")?._tag).toBe("Eligible");
}, 30_000);

test("superseded generations close after their last lease, and the session closes the rest", async () => {
  // Given a runtime whose every generation acquires a finalized resource
  const { a, b } = await twoApps();
  const closed: string[] = [];
  let built = 0;
  const resource = Layer.effectDiscard(
    Effect.acquireRelease(
      Effect.sync(() => ++built),
      (id) => Effect.sync(() => closed.push(`generation-${id}`)),
    ),
  );
  const session = await Effect.runPromise(Scope.make());

  const apps = await Effect.runPromise(
    openSession(sessionRuntime(a, [resource])).pipe(Scope.provide(session)),
  );
  const lease = await Effect.runPromise(Scope.make());
  // When B's generation is leased and its registry then changes
  const first = await Effect.runPromise(acquireIn(apps, b.root).pipe(Scope.provide(lease)));
  await writeFile(b.registry, `${await Bun.file(b.registry).text()}\n`);
  const second = await Effect.runPromise(Effect.scoped(acquireIn(apps, b.root)));
  const beforeRelease = [...closed];
  await Effect.runPromise(Scope.close(lease, Exit.void));
  const afterRelease = [...closed];
  await Effect.runPromise(Scope.close(session, Exit.void));

  // Then the superseded generation stays open until its lease ends, and session close ends the rest
  expect(second).not.toBe(first);
  expect(beforeRelease).toEqual([]);
  expect(afterRelease).toEqual(["generation-1"]);
  expect(closed).toEqual(["generation-1", "generation-2"]);
}, 30_000);

test("lifecycle subscribers dispatch from the publishing call's app generation", async () => {
  // Given two apps whose plugins both subscribe to the same command event
  const { a, b } = await twoApps();
  const event = Schema.decodeUnknownSync(LandoEvent)({
    _tag: "cli-fixture:shared-run",
    commandId: "fixture:shared",
    argv: [],
    args: {},
    flags: {},
    cwd: b.root,
    invocationId: "generation-subscribers",
    timestamp: DateTime.formatIso(DateTime.makeUnsafe("2026-11-06T00:00:00Z")),
    exitCode: 0,
    durationMs: 1,
  });

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const apps = yield* openSession(sessionRuntime(a));
        const generationA = yield* acquireIn(apps, a.root);
        const generationB = yield* acquireIn(apps, b.root);
        const publish = Effect.flatMap(EventService, (events) => events.publish(event));
        // When the event is published from B's call, then from A's call
        yield* publish.pipe(Effect.provide(generationB.context));
        yield* publish.pipe(Effect.provide(generationA.context));
      }),
    ),
  );

  // Then each publication reached only that app's subscriber, though B was built after A
  expect(fixtureDeliveries()).toEqual(["b/cli-fixture:shared-run", "a/cli-fixture:shared-run"]);
}, 30_000);

test("a command module that failed to load recovers after the missing file is created", async () => {
  // Given app B whose plugin imports fixture:lazy from a module that does not exist yet
  const parent = await fixtureRoot("lazy-command");
  roots.push(parent);
  const a = await writeFixtureApp(parent, "a", { commands: ["fixture:shared"], serviceType: "a-thing" });
  const b = await writeFixtureApp(parent, "b", {
    commands: ["fixture:shared"],
    serviceType: "b-thing",
    lazyCommand: "fixture:lazy",
  });

  const [first, second] = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const apps = yield* openSession(sessionRuntime(a));
        const first = yield* Effect.scoped(acquireIn(apps, b.root));
        // When the module is created, leaving the plugin entry and manifest untouched
        yield* Effect.promise(() => writeFile(b.lazyModule, lazyCommandSource("fixture:lazy")));
        const second = yield* Effect.scoped(acquireIn(apps, b.root));
        return [first, second] as const;
      }),
    ),
  );

  // Then the first call sees the owner's load failure and the next call projects that same owner
  expect(first.commands.get("fixture:lazy")).toMatchObject({
    _tag: "Failed",
    commandId: "fixture:lazy",
    error: { _tag: "PluginLoadError" },
  });
  expect(second.commands.get("fixture:lazy")).toMatchObject({
    _tag: "Eligible",
    entry: { spec: { id: "fixture:lazy" }, plugin: { name: "@example/app-b" } },
  });
  expect(second.context).not.toBe(first.context);
}, 30_000);

test("fifty subscriber reloads leave only the current generation registered", async () => {
  const { a, b } = await twoApps();
  const subscriber = join(dirname(b.entry), "subscriber.ts");
  const original = await Bun.file(subscriber).text();
  const event = Schema.decodeUnknownSync(LandoEvent)({
    _tag: "cli-fixture:shared-run",
    commandId: "fixture:shared",
    argv: [],
    args: {},
    flags: {},
    cwd: b.root,
    invocationId: "reload-subscribers",
    timestamp: "2026-11-06T00:00:00Z",
    exitCode: 0,
    durationMs: 0,
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const apps = yield* openSession(sessionRuntime(a));
        for (let index = 0; index <= 50; index++) {
          if (index > 0)
            yield* Effect.promise(() => writeFile(subscriber, original.replace('"b/"', `"b-${index}/"`)));
          yield* Effect.scoped(
            Effect.gen(function* () {
              const generation = yield* acquireIn(apps, b.root);
              yield* Context.get(generation.context, EventService)
                .publish(event)
                .pipe(Effect.provide(generation.context));
            }),
          );
        }
      }),
    ),
  );
  expect(fixtureDeliveries()).toEqual(
    Array.from({ length: 51 }, (_, index) => `${index === 0 ? "b" : `b-${index}`}/cli-fixture:shared-run`),
  );
}, 30_000);
