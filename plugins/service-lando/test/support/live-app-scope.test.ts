import { describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";

import type { AppId, AppPlan } from "@lando/sdk/schema";
import type { ExecResult } from "@lando/sdk/services";
import { Effect, Exit } from "effect";

import {
  type LiveAppLifecycle,
  acquireLiveApp,
  acquireTempAppRoot,
  execUntil,
  writeFixture,
} from "./live-app-scope.ts";

const plan = {
  id: "scopetest" as unknown as AppId,
  name: "Scope Test",
  slug: "scopetest",
  root: "/tmp/scopetest" as AppPlan["root"],
  provider: "lando" as AppPlan["provider"],
  services: {},
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata: { resolvedAt: "2026-05-28T00:00:00Z", source: "test", runtime: 4 },
  extensions: {},
} as unknown as AppPlan;

interface LifecycleCalls {
  readonly order: string[];
  readonly downOptions: Array<{ readonly volumes?: boolean | undefined }>;
}

const fakeLifecycle = (
  calls: LifecycleCalls,
  overrides: {
    readonly up?: Effect.Effect<void, string>;
    readonly down?: Effect.Effect<void, string>;
    readonly results?: ReadonlyArray<ExecResult>;
  } = {},
): LiveAppLifecycle => {
  let execIndex = 0;
  return {
    bringUp: () =>
      Effect.sync(() => {
        calls.order.push("up");
      }).pipe(Effect.flatMap(() => overrides.up ?? Effect.void)),
    bringDown: (_plan, _api, options) =>
      Effect.sync(() => {
        calls.order.push("down");
        calls.downOptions.push(options);
      }).pipe(Effect.flatMap(() => overrides.down ?? Effect.void)),
    exec: () =>
      Effect.sync(() => {
        const results = overrides.results ?? [];
        const result = results[Math.min(execIndex, results.length - 1)];
        execIndex += 1;
        if (result === undefined) throw new Error("no fake exec result configured");
        return result;
      }),
  };
};

const noCalls = (): LifecycleCalls => ({ order: [], downOptions: [] });

const okResult = (stdout: string): ExecResult => ({ exitCode: 0, stdout, stderr: "" });

describe("live-app-scope: temp app root", () => {
  test("creates the app root inside the scope and removes it when the scope closes", async () => {
    let captured = "";
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* acquireTempAppRoot("lando-scope-unit-");
          captured = root;
          const info = yield* Effect.promise(() => stat(root));
          expect(info.isDirectory()).toBe(true);
        }),
      ),
    );

    expect(captured).not.toBe("");
    await expect(stat(captured)).rejects.toThrow();
  });

  test("writes a fixture with parent directories and a daemon-readable mode", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* acquireTempAppRoot("lando-scope-unit-");
          const written = yield* writeFixture(root, "config/my.cnf", "[mysqld]\nmax_connections = 314\n");
          expect(written).toBe(join(root, "config/my.cnf"));
          const contents = yield* Effect.promise(() => readFile(written, "utf8"));
          expect(contents).toBe("[mysqld]\nmax_connections = 314\n");
          const info = yield* Effect.promise(() => stat(written));
          // The daemon runs as a non-root uid and reads the file through a bind mount.
          expect(info.mode & 0o004).toBe(0o004);
        }),
      ),
    );
  });
});

describe("live-app-scope: app lifecycle", () => {
  test("brings the app down with its volumes when the scope closes", async () => {
    const calls = noCalls();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* acquireLiveApp({ plan, socketPath: "/tmp/fake.sock", lifecycle: fakeLifecycle(calls) });
          expect(calls.order).toEqual(["up"]);
        }),
      ),
    );

    expect(calls.order).toEqual(["up", "down"]);
    expect(calls.downOptions).toEqual([{ volumes: true }]);
  });

  test("brings the app down even when the body fails", async () => {
    const calls = noCalls();
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          yield* acquireLiveApp({ plan, socketPath: "/tmp/fake.sock", lifecycle: fakeLifecycle(calls) });
          return yield* Effect.fail("body blew up");
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls.order).toEqual(["up", "down"]);
  });

  test("never brings down an app that failed to come up", async () => {
    const calls = noCalls();
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        acquireLiveApp({
          plan,
          socketPath: "/tmp/fake.sock",
          lifecycle: fakeLifecycle(calls, { up: Effect.fail("no runtime") }),
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls.order).toEqual(["up"]);
  });

  test("surfaces a teardown failure instead of swallowing it", async () => {
    const calls = noCalls();
    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        acquireLiveApp({
          plan,
          socketPath: "/tmp/fake.sock",
          lifecycle: fakeLifecycle(calls, { down: Effect.fail("volume busy") }),
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(calls.order).toEqual(["up", "down"]);
  });
});

describe("live-app-scope: daemon polling", () => {
  test("returns the first accepted result", async () => {
    const calls = noCalls();
    const lifecycle = fakeLifecycle(calls, {
      results: [okResult("still booting"), okResult("314")],
    });

    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* acquireLiveApp({ plan, socketPath: "/tmp/fake.sock", lifecycle });
          return yield* execUntil({
            app,
            service: "db",
            command: ["true"],
            accept: (candidate) => candidate.stdout.trim() === "314",
            timeoutMs: 5_000,
            intervalMs: 1,
          });
        }),
      ),
    );

    expect(result.stdout.trim()).toBe("314");
  });

  test("fails with the last observed output once the deadline passes", async () => {
    const calls = noCalls();
    const lifecycle = fakeLifecycle(calls, { results: [okResult("151")] });

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.gen(function* () {
          const app = yield* acquireLiveApp({ plan, socketPath: "/tmp/fake.sock", lifecycle });
          return yield* execUntil({
            app,
            service: "db",
            command: ["true"],
            accept: (candidate) => candidate.stdout.trim() === "314",
            timeoutMs: 20,
            intervalMs: 1,
          });
        }),
      ),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    const message = Exit.isFailure(exit) ? String(exit.cause) : "";
    expect(message).toContain("151");
  });
});
