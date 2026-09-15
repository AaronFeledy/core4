import { afterEach, expect, test } from "bun:test";
import { Deferred, Effect, Exit, Fiber } from "effect";

import { executeDbCommand } from "../src/execute.ts";
import { makeSqlTestDeps } from "./support/fakes.ts";

const harnesses: ReturnType<typeof makeSqlTestDeps>[] = [];
const setup = () => {
  const harness = makeSqlTestDeps({ password: "test-only", countStdout: "0" });
  harnesses.push(harness);
  return harness;
};
afterEach(() => {
  for (const harness of harnesses.splice(0)) harness.dispose();
});
const input = { action: "seed", file: "dump.sql.gz", yes: false } as const;

test("seed failure persists quarantine and refuses another claim", async () => {
  const harness = setup();
  const deps = { ...harness.deps, transfer: () => Effect.fail(new Error("import failed")) };
  const exit = await Effect.runPromiseExit(executeDbCommand(deps, input));
  expect(Exit.isFailure(exit)).toBe(true);
  const volume = await Effect.runPromise(harness.deps.inspectVolume("database", "sql-app_database_data"));
  if (!volume?.identity) throw new Error("fixture identity missing");
  const state = await Effect.runPromise(deps.initialization(volume.identity));
  expect((await Effect.runPromise(state.read))?.state._tag).toBe("failed");
  expect(await Effect.runPromise(state.begin("retry"))).toBe(false);
});

test("zero tables do not authorize seeding when shared state is absent", async () => {
  const harness = setup();
  const deps = {
    ...harness.deps,
    initialization: () =>
      Effect.succeed({
        read: Effect.succeed(null),
        begin: () => Effect.succeed(false),
        finish: () => Effect.succeed(false),
      }),
  };
  const exit = await Effect.runPromiseExit(executeDbCommand(deps, input));
  expect(Exit.isFailure(exit)).toBe(true);
  expect(harness.transfers()).toHaveLength(0);
});

test("adopted volumes cannot seed even if a caller supplies fresh state", async () => {
  const harness = setup();
  const deps = {
    ...harness.deps,
    inspectVolume: (service: string, store: string) =>
      harness.deps.inspectVolume(service, store).pipe(
        Effect.map((volume) =>
          volume?.identity === undefined
            ? volume
            : {
                ...volume,
                identity: { ...volume.identity, origin: "adopted" as const },
              },
        ),
      ),
  };
  const exit = await Effect.runPromiseExit(executeDbCommand(deps, input));
  expect(Exit.isFailure(exit)).toBe(true);
  expect(harness.transfers()).toHaveLength(0);
});

test("interruption after claim persists failed quarantine", async () => {
  const harness = setup();
  const state = await Effect.runPromise(
    Effect.gen(function* () {
      const volume = yield* harness.deps.inspectVolume("database", "sql-app_database_data");
      if (!volume?.identity) throw new Error("fixture identity missing");
      return yield* harness.deps.initialization(volume.identity);
    }),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const fiber = yield* Effect.fork(
        executeDbCommand(
          {
            ...harness.deps,
            transfer: () => Deferred.succeed(entered, undefined).pipe(Effect.zipRight(Effect.never)),
          },
          input,
        ),
      );
      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
    }),
  );
  expect((await Effect.runPromise(state.read))?.state._tag).toBe("failed");
  expect(await Effect.runPromise(state.begin("retry"))).toBe(false);
});

test("replacement after claim prevents all database mutation", async () => {
  const harness = setup();
  let replaced = false;
  const deps = {
    ...harness.deps,
    initialization: (identity: Parameters<typeof harness.deps.initialization>[0]) =>
      harness.deps.initialization(identity).pipe(
        Effect.map((state) => ({
          ...state,
          begin: (operationId: string) =>
            state.begin(operationId).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  replaced = true;
                }),
              ),
            ),
        })),
      ),
    inspectVolume: (service: string, store: string) =>
      harness.deps
        .inspectVolume(service, store)
        .pipe(
          Effect.map((volume) =>
            replaced && volume?.identity
              ? { ...volume, identity: { ...volume.identity, generation: "replacement" } }
              : volume,
          ),
        ),
  };
  const exit = await Effect.runPromiseExit(executeDbCommand(deps, input));
  expect(Exit.isFailure(exit)).toBe(true);
  expect(harness.transfers()).toHaveLength(0);
  expect(harness.lifecycle()).toEqual(["lock"]);
});
