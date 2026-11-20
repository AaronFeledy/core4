import { describe, expect, test } from "bun:test";
import { lstat, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { taggedErrorJson } from "@lando/sdk/command-result";
import type { LandoEvent } from "@lando/sdk/events";
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Result } from "effect";

import { ADVISORY_LOCK_SUFFIX, acquireAdvisoryLockAt } from "../../src/lock.ts";
import { lockTestAccess } from "./lock-test-access.ts";
import { capturingEventLayer, runWithScope, sentinelPath, withAdvisoryLock } from "./native-lock-support.ts";

const run = <A, E>(effect: Effect.Effect<A, E, never>): Promise<A> => Effect.runPromise(effect);

describe("advisory state lock contract", () => {
  test(`ADVISORY_LOCK_SUFFIX is ${JSON.stringify(".lck")}`, () => {
    expect(ADVISORY_LOCK_SUFFIX).toBe(".lck");
  });

  test("acquireAdvisoryLockAt is scope-managed and returns only a token", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-state-lock-"));
    const path = sentinelPath(dir, "transaction");
    try {
      const token = await runWithScope(
        Effect.gen(function* () {
          const lock = yield* acquireAdvisoryLockAt(path, "test", {
            privateFileAccess: lockTestAccess,
          });
          expect(typeof lock.token).toBe("string");
          expect(lock.token.length).toBeGreaterThan(0);
          expect(Object.keys(lock)).toEqual(["token"]);
          const record = yield* Effect.promise(
            async () =>
              JSON.parse(await readFile(path, "utf8")) as {
                token: string;
                pid: number;
              },
          );
          expect(record.token).toBe(lock.token);
          expect(record.pid).toBe(process.pid);
          return lock.token;
        }),
      );
      expect(token.length).toBeGreaterThan(0);
      expect(await Bun.file(path).exists()).toBe(process.platform === "win32");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("withAdvisoryLockUsing derives the sentinel with ADVISORY_LOCK_SUFFIX", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-state-lock-")));
    try {
      const file = join(dir, "state.json");
      await writeFile(file, "{}\n");
      const observed = await run(
        withAdvisoryLock(
          file,
          "test",
          Effect.promise(async () => {
            const sentinel = `${file}${ADVISORY_LOCK_SUFFIX}`;
            expect((await lstat(sentinel)).isFile()).toBe(true);
            return "ok";
          }),
        ),
      );
      expect(observed).toBe("ok");
      expect(await Bun.file(`${file}${ADVISORY_LOCK_SUFFIX}`).exists()).toBe(process.platform === "win32");
      await expect(stat(`${file}.lock`)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test.skipIf(process.platform === "win32")("pins 0600 under a restrictive umask", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-state-lock-"));
    const path = sentinelPath(dir, "transaction");
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "--eval",
          `
        import { Effect } from ${JSON.stringify(import.meta.resolve("effect"))};
        import { acquireAdvisoryLockAt } from ${JSON.stringify(import.meta.resolve("../../src/lock.ts"))};
        import { lockTestAccess } from ${JSON.stringify(import.meta.resolve("./lock-test-access.ts"))};
        import { stat } from "node:fs/promises";
        process.umask(0o777);
        const path = ${JSON.stringify(path)};
        await Effect.runPromise(Effect.scoped(
          Effect.gen(function* () {
            yield* acquireAdvisoryLockAt(path, "test", { privateFileAccess: lockTestAccess });
            // umask may clear owner bits; group/other must stay closed (private-file contract).
            const mode = yield* Effect.promise(async () => (await stat(path)).mode & 0o777);
            if ((mode & 0o077) !== 0) throw new Error("mode mismatch: " + mode.toString(8));
          }),
        ));
      `,
        ],
        { stdout: "pipe", stderr: "pipe" },
      );
      const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("zero budget is one nonblocking attempt on a different fiber", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-state-lock-"));
    const path = sentinelPath(dir, "held");
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* acquireAdvisoryLockAt(path, "holder", {
              privateFileAccess: lockTestAccess,
            });
            const started = Date.now();
            // Contending acquire must be a different fiber (same-fiber reentry dies).
            const result = yield* Effect.result(
              Effect.forkChild(
                Effect.scoped(
                  acquireAdvisoryLockAt(path, "waiter", {
                    privateFileAccess: lockTestAccess,
                    timeoutMs: 0,
                    resource: "cache-volume",
                  }),
                ),
              ).pipe(Effect.flatMap(Fiber.join)),
            );
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure") {
              expect(result.failure).toMatchObject({
                reason: "lock",
                lockFailure: "timeout",
                resource: "cache-volume",
                timeoutMs: 0,
              });
            }
            expect(Date.now() - started).toBeLessThan(500);
          }),
        ),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("timeout projects resource, ownerPid, heldMs, and timeoutMs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-state-lock-"));
    const path = sentinelPath(dir, "held");
    const events: LandoEvent[] = [];
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* acquireAdvisoryLockAt(path, "holder", {
              privateFileAccess: lockTestAccess,
              resource: "app-mutation",
            });
            const error = yield* Effect.flip(
              Effect.forkChild(
                Effect.scoped(
                  acquireAdvisoryLockAt(path, "waiter", {
                    privateFileAccess: lockTestAccess,
                    timeoutMs: 30,
                    resource: "app-mutation",
                  }),
                ),
              ).pipe(Effect.flatMap(Fiber.join)),
            );
            expect(error).toMatchObject({
              _tag: "StateStoreError",
              reason: "lock",
              lockFailure: "timeout",
              resource: "app-mutation",
              ownerPid: process.pid,
              timeoutMs: 30,
              path,
            });
            expect(error.heldMs).toBeGreaterThanOrEqual(0);
            expect(error.message).toContain(
              `Timed out after 30ms waiting for app-mutation, held by process ${process.pid}`,
            );
            expect(error.remediation).toMatch(/LANDO_LOCK_TIMEOUT_MS/);
            expect(error.remediation).not.toMatch(/remove .*lck/i);
            const projected = taggedErrorJson(error);
            expect(projected).toMatchObject({
              _tag: "StateStoreError",
              lockFailure: "timeout",
              resource: "app-mutation",
              ownerPid: process.pid,
              timeoutMs: 30,
            });
            expect(typeof projected.heldMs).toBe("number");
          }),
        ).pipe(Effect.provide(capturingEventLayer(events))),
      );
      expect(events.filter((event) => event._tag === "message.warn")).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a brief lock that stays contended announces once after one second", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-state-lock-"));
    const path = sentinelPath(dir, "contended");
    const events: LandoEvent[] = [];
    const warned = Deferred.makeUnsafe<string>();
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* acquireAdvisoryLockAt(path, "holder", {
              privateFileAccess: lockTestAccess,
              resource: "routes",
            });
            const start = yield* Clock.monotonicTimeNanos;
            const waiter = yield* Effect.forkChild(
              Effect.scoped(
                acquireAdvisoryLockAt(path, "waiter", {
                  privateFileAccess: lockTestAccess,
                  resource: "routes",
                }),
              ).pipe(Effect.flip),
            );
            const body = yield* Deferred.await(warned).pipe(Effect.timeout("3 seconds"));
            expect((yield* Clock.monotonicTimeNanos) - start).toBeGreaterThanOrEqual(1_000_000_000n);
            expect(body).toContain(`Waiting for routes, held by process ${process.pid}`);
            const error = yield* Fiber.join(waiter);
            expect(error.message).toContain("Timed out after 2s waiting for routes");
            expect(error.timeoutMs).toBe(2_000);
          }),
        ).pipe(
          Effect.provide(
            capturingEventLayer(events, (body) => Deferred.succeed(warned, body).pipe(Effect.asVoid)),
          ),
        ),
      );
      const warns = events.filter((event) => event._tag === "message.warn");
      expect(warns.length).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("shared mode allows concurrent shared holders on different fibers", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-state-lock-"));
    const path = sentinelPath(dir, "shared");
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const first = yield* acquireAdvisoryLockAt(path, "a", {
              privateFileAccess: lockTestAccess,
              mode: "shared",
            });
            const secondFiber = yield* Effect.forkChild(
              Effect.scoped(
                acquireAdvisoryLockAt(path, "b", {
                  privateFileAccess: lockTestAccess,
                  mode: "shared",
                }),
              ),
            );
            const second = yield* Fiber.join(secondFiber);
            expect(first.token).not.toBe(second.token);
          }),
        ),
      );
      expect((await lstat(path)).isFile()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("exclusive acquisition fails while a shared holder is active", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-state-lock-"));
    const path = sentinelPath(dir, "shared-vs-ex");
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* acquireAdvisoryLockAt(path, "shared", {
              privateFileAccess: lockTestAccess,
              mode: "shared",
            });
            const result = yield* Effect.result(
              Effect.forkChild(
                Effect.scoped(
                  acquireAdvisoryLockAt(path, "exclusive", {
                    privateFileAccess: lockTestAccess,
                    mode: "exclusive",
                    timeoutMs: 0,
                  }),
                ),
              ).pipe(Effect.flatMap(Fiber.join)),
            );
            expect(result._tag).toBe("Failure");
            if (result._tag === "Failure") {
              expect(result.failure.lockFailure).toBe("timeout");
            }
          }),
        ),
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a stale diagnostic record alone never blocks acquisition", async () => {
    const dir = await mkdtemp(join(tmpdir(), "lando-state-lock-"));
    const path = sentinelPath(dir, "stale-bytes");
    await writeFile(path, JSON.stringify({ pid: 99_999_999, token: "stale", createdAt: Date.now() }), {
      mode: 0o600,
    });
    try {
      const token = await runWithScope(
        Effect.gen(function* () {
          const lock = yield* acquireAdvisoryLockAt(path, "test", {
            privateFileAccess: lockTestAccess,
          });
          return lock.token;
        }),
      );
      expect(token).not.toBe("stale");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("symlink sentinel fails promptly as a path error", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-state-lock-")));
    try {
      const file = join(dir, "state.json");
      const target = join(dir, "elsewhere");
      await writeFile(file, "{}\n");
      await writeFile(target, "x");
      await symlink(target, `${file}${ADVISORY_LOCK_SUFFIX}`);
      const started = Date.now();
      const result = await Effect.runPromiseExit(
        withAdvisoryLock(file, "test", Effect.succeed("unreachable"), { timeoutMs: 10_000 }),
      );
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(result._tag).toBe("Failure");
      expect(JSON.stringify(result)).toMatch(/symbolic link|path|Unsafe/i);
      expect((await lstat(`${file}${ADVISORY_LOCK_SUFFIX}`)).isSymbolicLink()).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("withAdvisoryLock releases after body failure so a later acquire succeeds", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-state-lock-")));
    try {
      const file = join(dir, "state.json");
      await writeFile(file, "{}\n");
      const result = await Effect.runPromiseExit(
        withAdvisoryLock(file, "test", Effect.fail("expected failure")),
      );
      expect(result._tag).toBe("Failure");
      expect(await run(withAdvisoryLock(file, "test", Effect.succeed("reacquired")))).toBe("reacquired");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("withAdvisoryLock releases after interruption", async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-state-lock-")));
    try {
      const file = join(dir, "state.json");
      await writeFile(file, "{}\n");
      await run(
        Effect.gen(function* () {
          const entered = yield* Deferred.make<void>();
          const fiber = yield* Effect.forkChild(
            withAdvisoryLock(
              file,
              "test",
              Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
            ),
          );
          yield* Deferred.await(entered);
          yield* Fiber.interrupt(fiber);
        }),
      );
      expect(await run(withAdvisoryLock(file, "test", Effect.succeed("reacquired")))).toBe("reacquired");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

test("same-fiber re-entry dies at once instead of waiting on its own lock", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-state-lock-")));
  try {
    const file = join(dir, "state.json");
    await writeFile(file, "{}\n");
    const result = await Effect.runPromiseExit(
      withAdvisoryLock(file, "test", withAdvisoryLock(file, "test", Effect.succeed("unreachable"))).pipe(
        Effect.timeout("1 second"),
      ),
    );
    expect(Exit.isFailure(result)).toBe(true);
    if (Exit.isFailure(result)) {
      const defect = Cause.findDefect(result.cause);
      expect(Result.isSuccess(defect)).toBe(true);
      if (Result.isSuccess(defect)) {
        expect(String(defect.success)).toContain(`${file}${ADVISORY_LOCK_SUFFIX}`);
        expect(String(defect.success)).toMatch(/re-entry|deadlock/i);
      }
    }
    expect(await run(withAdvisoryLock(file, "test", Effect.succeed("released")))).toBe("released");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a different fiber waits for the held lock and then acquires it", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-state-lock-")));
  try {
    const file = join(dir, "state.json");
    await writeFile(file, "{}\n");
    const entered = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const secondEntered = await Effect.runPromise(Deferred.make<void>());
    const first = Effect.runFork(
      withAdvisoryLock(
        file,
        "test",
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      ),
    );
    await Effect.runPromise(Deferred.await(entered));
    const second = Effect.runFork(withAdvisoryLock(file, "test", Deferred.succeed(secondEntered, undefined)));
    const beforeRelease = await Effect.runPromise(Deferred.poll(secondEntered));
    await Effect.runPromise(Deferred.succeed(release, undefined));
    await Effect.runPromise(Fiber.join(first));
    await Effect.runPromise(Fiber.join(second));
    expect(beforeRelease._tag).toBe("None");
    expect((await Effect.runPromise(Deferred.poll(secondEntered)))._tag).toBe("Some");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("interruption while holding clears the holder for a later acquisition", async () => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-state-lock-")));
  try {
    const file = join(dir, "state.json");
    await writeFile(file, "{}\n");
    await run(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          withAdvisoryLock(
            file,
            "test",
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        );
        yield* Deferred.await(entered);
        yield* Fiber.interrupt(fiber);
      }),
    );
    const reacquired = await run(withAdvisoryLock(file, "test", Effect.succeed("reacquired")));
    expect(reacquired).toBe("reacquired");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
