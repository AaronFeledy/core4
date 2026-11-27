import { expect, spyOn, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { TEST_ROOT_ENV_KEYS } from "@lando/engine/testing/temp-root-retirement";
import { MissingLiveTestBinaryError, runWithLiveTestRoots } from "./live-test-roots.ts";

const socketEnv = {
  LANDO_TEST_PODMAN_SOCKET: "/unused-fake.sock",
  LANDO_SHELL_PROFILE: "/caller-profile",
  LANDO_SCENARIO_E2E_BINARY: process.execPath,
};
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
          expect(dirname(env.LANDO_SHELL_PROFILE ?? "")).toBe(directory);
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

const mustNotRun = (step: string) => async (): Promise<never> => {
  throw new Error(`${step} must not run`);
};

test.each([
  {
    name: "a missing override",
    reason: "missing",
    binary: async (base: string) => join(base, "missing-lando"),
  },
  { name: "a directory override", reason: "directory", binary: async (base: string) => base },
  ...(process.platform === "win32"
    ? []
    : [
        {
          name: "a non-executable override",
          reason: "not-executable",
          binary: async (base: string) => {
            const file = join(base, "lando");
            await writeFile(file, "not executable");
            await chmod(file, 0o644);
            return file;
          },
        },
      ]),
  { name: "a missing default build", reason: "missing", binary: async () => undefined },
])("rejects $name before preparing, running, or retiring", async ({ reason, binary }) => {
  const base = await mkdtemp(join(tmpdir(), "lando-live-binary-"));
  try {
    const override = await binary(base);
    const path = override ?? resolve(base, "core/dist/lando");
    const { LANDO_SCENARIO_E2E_BINARY: _binary, ...env } = socketEnv;
    const error = await runWithLiveTestRoots(
      {
        live: true,
        cwd: base,
        env: override === undefined ? env : { ...env, LANDO_SCENARIO_E2E_BINARY: override },
      },
      mustNotRun("run"),
      mustNotRun("retire"),
      mustNotRun("prepare"),
    ).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(MissingLiveTestBinaryError);
    // The message names the checked path and marks when the override chose it.
    const source = override === undefined ? "" : " (LANDO_SCENARIO_E2E_BINARY)";
    expect(error).toMatchObject({ reason, path, message: expect.stringContaining(`${path}${source} `) });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test("retire command with a missing binary exits 2 without posix_spawn and leaves the directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lando-live-retire-"));
  await mkdir(join(directory, "keep"), { recursive: true });
  const missing = join(directory, "missing-lando");
  const child = Bun.spawnSync({
    cmd: [process.execPath, join(import.meta.dir, "live-test-roots.ts"), "retire", directory],
    cwd: directory,
    env: {
      ...process.env,
      LANDO_TEST_PODMAN_SOCKET: "/unused-fake.sock",
      LANDO_SCENARIO_E2E_BINARY: missing,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  try {
    expect(child.exitCode).toBe(2);
    const stderr = child.stderr.toString();
    expect(stderr).toContain("(cd core && bun run build)");
    expect(stderr).toContain("LANDO_SCENARIO_E2E_BINARY");
    expect(stderr).not.toContain("posix_spawn");
    expect(stderr).not.toContain("ENOENT");
    expect(await readdir(directory)).toContain("keep");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
