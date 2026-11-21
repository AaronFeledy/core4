/**
 * App mutation locks across real compiled `lando` processes: a killed holder frees its lock with
 * no wait, and a waiter that runs out of budget fails with a structured `AppLockTimeoutError`.
 * A build step blocked on a FIFO holds the first command inside its app lock, so no test waits on
 * a timer to know a lock is held.
 */
import { describe, expect, test } from "bun:test";
import {
  closeSync,
  constants,
  existsSync,
  openSync,
  readFileSync,
  readdirSync,
  watch,
  writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { ScenarioContextFactory, type ScenarioRunResult } from "@lando/core/testing";
import { makeLandoPaths } from "@lando/paths";
import { Effect, Fiber, Option, Schema } from "effect";

import { withEnvVar } from "../_support/temp-cwd.ts";
import { isScannerLiveEligible, managedProviderSocketPath } from "./scanner-live-fixture.ts";

const binary = resolve(process.env.LANDO_SCENARIO_E2E_BINARY ?? join(import.meta.dir, "../../dist/lando"));
const prerequisite =
  process.platform !== "linux"
    ? "The FIFO-blocked build step needs a Linux bind mount."
    : !isScannerLiveEligible()
      ? `Set LANDO_TEST_PODMAN_SOCKET to the answering managed socket ${managedProviderSocketPath} and preserve that installation's LANDO_USER_* roots.`
      : !existsSync(binary)
        ? `Build the compiled CLI or set LANDO_SCENARIO_E2E_BINARY; missing ${binary}.`
        : undefined;

const HOLDING = ".lock-live-holding";
const RELEASE = "lock-live-release.fifo";

const landofile = (name: string) =>
  [
    `name: ${name}`,
    "router:",
    "  enabled: false",
    "services:",
    "  cli:",
    "    type: php:8.3",
    "    via: cli",
    "    build:",
    "      app:",
    `        - "touch /app/${HOLDING} && cat /app/${RELEASE} > /dev/null"`,
    "",
  ].join("\n");

const LockRecord = Schema.fromJsonString(
  Schema.Struct({
    pid: Schema.Int,
    app: Schema.optional(Schema.String),
    command: Schema.optional(Schema.String),
  }),
);

const ErrorEnvelope = Schema.fromJsonString(
  Schema.Struct({
    ok: Schema.Literal(false),
    error: Schema.Struct({
      _tag: Schema.String,
      timeoutMs: Schema.optional(Schema.Number),
    }),
  }),
);

const frames = (stdout: string): ReadonlyArray<Record<string, unknown>> =>
  stdout.split("\n").flatMap((line) => {
    if (!line.startsWith("{")) return [];
    const parsed: unknown = JSON.parse(line);
    return typeof parsed === "object" && parsed !== null ? [parsed as Record<string, unknown>] : [];
  });

/** `lock.wait` event frames a streaming `--format=json` run wrote to stdout. */
const lockWaits = (run: ScenarioRunResult) =>
  frames(run.stdout).filter((frame) => frame._tag === "event" && frame.event === "lock.wait");

/** Resolve once `name` appears in `dir`; the watcher is installed before the existence check. */
const waitForFile = (dir: string, name: string) =>
  Effect.callback<void>((resume) => {
    const watcher = watch(dir, (_event, filename) => {
      if (filename === name) resume(Effect.void);
    });
    if (existsSync(join(dir, name))) resume(Effect.void);
    return Effect.sync(() => watcher.close());
  }).pipe(Effect.timeout("5 minutes"));

/** Unblock the build step's reader, if any. ENXIO means no reader is left, which is fine. */
const release = (dir: string) =>
  Effect.sync(() => {
    let fd: number;
    try {
      fd = openSync(join(dir, RELEASE), constants.O_WRONLY | constants.O_NONBLOCK);
    } catch (cause) {
      if (cause instanceof Error && Reflect.get(cause, "code") === "ENXIO") return;
      throw cause;
    }
    try {
      writeSync(fd, "go\n");
    } finally {
      closeSync(fd);
    }
  });

/** The pid recorded by the exclusive holder of `app`'s mutation lock. */
const appLockHolderPid = (app: string): number => {
  const dir = join(makeLandoPaths().roots.userDataRoot, "operation-locks");
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith("app-") || !entry.endsWith(".lck")) continue;
    const record = Schema.decodeUnknownOption(LockRecord)(readFileSync(join(dir, entry), "utf8"));
    if (Option.isSome(record) && record.value.app === app) return record.value.pid;
  }
  throw new Error(`No app lock record names ${app}.`);
};

const envFor = (name: string, value: string, run: Effect.Effect<ScenarioRunResult, unknown>) =>
  Effect.promise(() => withEnvVar(name, value, () => Effect.runPromise(run)));

describe.serial("live advisory app locks", () => {
  test.skipIf(prerequisite !== undefined)(
    "a killed holder frees the app lock, and waiters time out with a structured error",
    async () => {
      await Effect.runPromise(
        ScenarioContextFactory.e2e(
          { guideId: "advisory-lock-live", scenarioId: "app-lock", render: false },
          (ctx) =>
            Effect.gen(function* () {
              const name = `lock-live-${crypto.randomUUID().slice(0, 8)}`;
              yield* Effect.promise(() => Bun.write(join(ctx.testDir, ".lando.yml"), landofile(name)));
              yield* Effect.promise(() => Bun.$`mkfifo ${join(ctx.testDir, RELEASE)}`.quiet());
              yield* Effect.addFinalizer(() =>
                release(ctx.testDir).pipe(
                  Effect.andThen(ctx.runCli(["destroy", "-y", "--volumes", "--format=json"])),
                  Effect.ignore,
                ),
              );

              // Given a start parked in its build step, inside the app lock.
              const holder = yield* Effect.forkChild(ctx.runCli(["start", "--format=json"]));
              yield* waitForFile(ctx.testDir, HOLDING);

              // When a stop has no budget, it fails at once without announcing a wait.
              const zero = yield* envFor("LANDO_LOCK_TIMEOUT_MS", "0", ctx.runCli(["stop", "--format=json"]));
              expect(zero.exitCode).not.toBe(0);
              expect(Schema.decodeUnknownSync(ErrorEnvelope)(zero.stdout).error).toMatchObject({
                _tag: "AppLockTimeoutError",
                timeoutMs: 0,
              });

              // When a second start has a short budget, its JSON stream announces the holder once and
              // ends with the timeout.
              const waited = yield* envFor(
                "LANDO_LOCK_TIMEOUT_MS",
                "1500",
                ctx.runCli(["start", "--format=json"]),
              );
              expect(waited.exitCode).not.toBe(0);
              expect(lockWaits(waited)).toEqual([
                expect.objectContaining({
                  payload: expect.objectContaining({
                    subject: "app",
                    reminder: false,
                    holder: expect.objectContaining({ command: "lando start", app: name }),
                  }),
                }),
              ]);
              expect(frames(waited.stdout).at(-1)).toMatchObject({
                _tag: "result",
                envelope: { ok: false, error: { _tag: "AppLockTimeoutError", timeoutMs: 1500 } },
              });

              // And human output names the holder and the tagged failure, not an internal error.
              const human = yield* envFor("LANDO_LOCK_TIMEOUT_MS", "1500", ctx.runCli(["stop"]));
              expect(human.exitCode).not.toBe(0);
              expect(human.stderr).toContain(`Waiting for lando start in ${name} to finish`);
              expect(human.stderr).toContain("code: AppLockTimeoutError");
              expect(human.stderr).not.toContain("internal Lando error");

              // When the holder is killed, the next command takes the lock without waiting.
              process.kill(appLockHolderPid(name), "SIGKILL");
              const killed = yield* Fiber.join(holder);
              expect(killed.exitCode).not.toBe(0);
              const next = yield* ctx.runCli(["stop"]);
              expect(next.exitCode, next.stderr).toBe(0);
              expect(next.stderr).not.toContain("Waiting for");
            }),
        ),
      );
    },
    900_000,
  );
});
