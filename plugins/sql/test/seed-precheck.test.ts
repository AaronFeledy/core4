import { afterEach, expect, test } from "bun:test";
import { StateStoreError } from "@lando/sdk/errors";
import { AbsolutePath } from "@lando/sdk/schema";
import { Cause, Effect, Exit, Option, Stream } from "effect";
import { executeDbCommand } from "../src/execute.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

afterEach(cleanupSqlTestDeps);

test.each(["seeded", "in-progress", "failed", "adopted", "foreign-owner"] as const)(
  "refuses %s stdin seed without pulling stdin or touching the database",
  async (scenario) => {
    const harness = makeSqlTestDeps({
      password: "test-only",
      seedStatus: scenario === "adopted" || scenario === "foreign-owner" ? "fresh" : scenario,
    });
    const deps = {
      ...harness.deps,
      inspectVolume: (...args: Parameters<typeof harness.deps.inspectVolume>) =>
        harness.deps.inspectVolume(...args).pipe(
          Effect.map((volume) =>
            volume?.identity === undefined
              ? volume
              : {
                  ...volume,
                  identity: {
                    ...volume.identity,
                    ...(scenario === "adopted" ? { origin: "adopted" as const } : {}),
                    ...(scenario === "foreign-owner" ? { ownerRoot: AbsolutePath.make("/another-app") } : {}),
                  },
                },
          ),
        ),
    };
    let pulled = false;
    const stdin = Stream.fromEffect(
      Effect.sync(() => {
        pulled = true;
        return new TextEncoder().encode("select 1;\n");
      }),
    );

    const exit = await Effect.runPromiseExit(
      executeDbCommand(deps, {
        action: "seed",
        file: "-",
        yes: false,
        stdio: { stdin },
      }),
    );

    const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
    expect(error).toMatchObject({
      _tag: "SqlSeedStateError",
      status: scenario === "adopted" || scenario === "foreign-owner" ? "unknown" : scenario,
    });
    expect(pulled).toBe(false);
    expect(harness.lifecycle()).toEqual([]);
    expect(harness.execs()).toEqual([]);
    expect(harness.countAttempts()).toBe(0);
    expect(harness.transfers()).toEqual([]);
  },
);

test.each([
  "identity-unavailable",
  "inspect-failure",
  "initialization-failure",
  "read-failure",
  "missing-record",
] as const)("defers %s to the locked check and still seeds eligible stdin", async (scenario) => {
  const harness = makeSqlTestDeps({ password: "test-only", countStdout: "0" });
  let inspected = false;
  let initialized = false;
  const deps = {
    ...harness.deps,
    inspectVolume: (...args: Parameters<typeof harness.deps.inspectVolume>) =>
      Effect.suspend(() => {
        const first = !inspected;
        inspected = true;
        if (first && scenario === "inspect-failure") return Effect.fail(new Error("lookup unavailable"));
        if (first && scenario === "identity-unavailable") return Effect.succeed(undefined);
        return harness.deps.inspectVolume(...args);
      }),
    initialization: (identity: Parameters<typeof harness.deps.initialization>[0]) =>
      Effect.suspend(() => {
        const first = !initialized;
        initialized = true;
        if (first && scenario === "initialization-failure")
          return Effect.fail(new Error("state unavailable"));
        return harness.deps.initialization(identity).pipe(
          Effect.map((state) => ({
            ...state,
            read:
              first && scenario === "read-failure"
                ? Effect.fail(
                    new StateStoreError({ reason: "io", operation: "read", remediation: "Retry the read." }),
                  )
                : first && scenario === "missing-record"
                  ? Effect.succeed(null)
                  : state.read,
          })),
        );
      }),
  };
  let pulled = false;
  const stdin = Stream.fromEffect(
    Effect.sync(() => {
      pulled = true;
      return new TextEncoder().encode("select 1;\n");
    }),
  );

  const result = await Effect.runPromise(
    executeDbCommand(deps, {
      action: "seed",
      file: "-",
      yes: false,
      stdio: { stdin },
    }),
  );

  expect(result.seedStatus).toBe("seeded");
  expect(pulled).toBe(true);
  expect(harness.transfers()).toHaveLength(1);
  expect(harness.lifecycle()).toEqual(["lock"]);
});

test("refuses a stdin seed into a non-empty database before pulling stdin", async () => {
  // Given a fresh initialization record but a database that already has tables.
  const harness = makeSqlTestDeps({ password: "test-only", countStdout: "3" });
  let pulled = false;
  const stdin = Stream.fromEffect(
    Effect.sync(() => {
      pulled = true;
      return new TextEncoder().encode("select 1;\n");
    }),
  );

  // When the seed runs.
  const exit = await Effect.runPromiseExit(
    executeDbCommand(harness.deps, { action: "seed", file: "-", yes: false, stdio: { stdin } }),
  );

  // Then it fails as not empty without reading stdin, claiming the volume, or transferring.
  const error = Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined;
  expect(error).toMatchObject({ _tag: "SqlSeedStateError", status: "fresh" });
  expect(pulled).toBe(false);
  expect(harness.lifecycle()).toEqual([]);
  expect(harness.transfers()).toEqual([]);
});

test("defers a failed early count to the locked check and still seeds", async () => {
  // Given a database whose first count fails, as when the client isn't ready yet.
  const harness = makeSqlTestDeps({ password: "test-only", countStdout: "0", countFailuresBeforeSuccess: 1 });
  const stdin = Stream.make(new TextEncoder().encode("select 1;\n"));

  // When the seed runs.
  const result = await Effect.runPromise(
    executeDbCommand(harness.deps, { action: "seed", file: "-", yes: false, stdio: { stdin } }),
  );

  // Then the locked check counts again and the seed proceeds.
  expect(result.seedStatus).toBe("seeded");
  expect(harness.countAttempts()).toBe(2);
  expect(harness.transfers()).toHaveLength(1);
});
