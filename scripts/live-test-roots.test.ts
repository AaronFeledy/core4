import { expect, spyOn, test } from "bun:test";
import { rm } from "node:fs/promises";
import { dirname } from "node:path";
import { TEST_ROOT_ENV_KEYS } from "@lando/engine/testing/temp-root-retirement";
import { runWithLiveTestRoots } from "./live-test-roots.ts";

const socketEnv = { LANDO_TEST_PODMAN_SOCKET: "/unused-fake.sock" };
const prepared = async () => 0;

test("forwards TERM and waits for the test child before retiring", async () => {
  const exited = Promise.withResolvers<number>();
  const started = Promise.withResolvers<void>();
  const signals: unknown[] = [];
  const events: string[] = [];
  const run = runWithLiveTestRoots(
    { live: true, cwd: import.meta.dir, env: socketEnv },
    async (_env, track) => {
      track({
        kill: (signal) => {
          signals.push(signal);
        },
        exited: exited.promise,
        exitCode: null,
        signalCode: null,
      });
      started.resolve();
      return exited.promise;
    },
    async ({ directory }) => {
      events.push("retire");
      await rm(directory, { recursive: true, force: true });
      return { removed: [], retained: [], failed: [] };
    },
    prepared,
  );
  await started.promise;
  process.emit("SIGTERM", "SIGTERM");
  const beforeExit = [...events];
  events.push("reap");
  exited.resolve(0);
  expect(await run).toBe(143);
  expect(signals).toEqual(["SIGTERM"]);
  expect(beforeExit).toEqual([]);
  expect(events).toEqual(["reap", "retire"]);
});

test.each([
  ...TEST_ROOT_ENV_KEYS.map((key) => ({ ...socketEnv, [key]: "/caller-owned" })),
  { ...socketEnv, LANDO_USER_CACHE_ROOT: "" },
  { ...socketEnv, LANDO_TEST_USE_REAL_ROOTS: "1" },
  {},
])("does not take ownership with caller-owned roots or no live endpoint: %j", async (env) => {
  const exit = await runWithLiveTestRoots(
    { live: true, cwd: import.meta.dir, env },
    async (childEnv) => {
      expect(childEnv).toEqual(env);
      return 7;
    },
    async () => {
      throw new Error("Caller-owned roots must not be retired.");
    },
    async () => {
      throw new Error("Caller-owned roots must not be prepared.");
    },
  );
  expect(exit).toBe(7);
});

test("retires once and preserves the child error when launching or collecting tests throws", async () => {
  const childError = new Error("test child could not be collected");
  let retirements = 0;
  await expect(
    runWithLiveTestRoots(
      { live: true, cwd: import.meta.dir, env: socketEnv },
      async () => {
        throw childError;
      },
      async ({ directory }) => {
        retirements++;
        await rm(directory, { recursive: true, force: true });
        return { removed: [], retained: [], failed: [] };
      },
      prepared,
    ),
  ).rejects.toBe(childError);
  expect(retirements).toBe(1);
});

test.each([
  [0, false, 0],
  [7, false, 7],
  [0, true, 1],
  [7, true, 7],
] as const)("run exits %i with retirement failure=%s (combined status %i)", async (code, fails, combined) => {
  let reaped = false;
  let retirements = 0;
  const diagnostic = spyOn(console, "error").mockImplementation(() => undefined);
  try {
    const exit = await runWithLiveTestRoots(
      { live: true, cwd: import.meta.dir, env: socketEnv },
      async (env) => {
        expect(Object.isFrozen(env)).toBe(true);
        reaped = true;
        return code;
      },
      async ({ directory, env, endpoint }) => {
        try {
          expect(reaped).toBe(true);
          retirements++;
          for (const key of TEST_ROOT_ENV_KEYS) expect(dirname(env[key] ?? "")).toBe(directory);
          expect(endpoint).toBe(socketEnv.LANDO_TEST_PODMAN_SOCKET);
          return {
            removed: [],
            retained: fails ? [{ target: "built image", reason: "in use" }] : [],
            failed: [],
          };
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
      prepared,
    );
    expect(exit).toBe(combined);
    expect(retirements).toBe(1);
    expect(diagnostic).toHaveBeenCalledTimes(fails ? 1 : 0);
    if (fails)
      expect(JSON.parse(diagnostic.mock.calls[0]?.[1] ?? "")).toMatchObject({
        testExitCode: code,
        endpoint: socketEnv.LANDO_TEST_PODMAN_SOCKET,
      });
  } finally {
    diagnostic.mockRestore();
  }
});

test("a failed root preparation skips the tests, still retires, and reports its status", async () => {
  let ran = false;
  let retirements = 0;
  const exit = await runWithLiveTestRoots(
    { live: true, cwd: import.meta.dir, env: socketEnv },
    async () => {
      ran = true;
      return 0;
    },
    async ({ directory }) => {
      retirements++;
      await rm(directory, { recursive: true, force: true });
      return { removed: [], retained: [], failed: [] };
    },
    async ({ env }) => {
      expect(env.LANDO_USER_DATA_ROOT).toBeDefined();
      return 3;
    },
  );
  expect(exit).toBe(3);
  expect(ran).toBe(false);
  expect(retirements).toBe(1);
});
