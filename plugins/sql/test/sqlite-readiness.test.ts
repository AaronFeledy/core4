import { afterEach, expect, test } from "bun:test";
import { Effect } from "effect";
import { withSuspendedSqlite } from "../src/sqlite-suspension.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

afterEach(cleanupSqlTestDeps);
test.each([false, true])(
  "SQLite resume readiness failure preserves a prior mutation failure (%s)",
  async (mutationFails) => {
    const f = makeSqlTestDeps({ password: "secret" });
    const failure = await Effect.runPromise(
      withSuspendedSqlite(
        { ...f.deps, waitForReady: () => Effect.fail("effective readiness failed") },
        { kind: "file", family: "sqlite", name: "database", type: "php", path: "db.sqlite" },
        () => (mutationFails ? Effect.fail("mutation failed") : Effect.succeed("completed")),
      ).pipe(Effect.flip),
    );
    expect(failure).toBe(mutationFails ? "mutation failed" : "effective readiness failed");
    expect(f.published()).toEqual(mutationFails ? ["message.warn"] : []);
  },
);
