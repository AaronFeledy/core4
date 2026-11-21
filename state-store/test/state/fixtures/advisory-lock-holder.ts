/**
 * Child process (source or compiled) that holds an advisory lock until stdin EOF.
 *
 * Protocol (stdout lines):
 *   ready <pid> <token or -> [opened|locked|recorded]
 *   released
 * stderr is diagnostics only; nonzero exit is a fixture failure.
 *
 * argv: <sentinelPath> [exclusive|shared] [resource]
 * LANDO_TEST_LOCK_PAUSE_AT selects an acquisition phase instead of the usual ready line.
 */
import { readSync, writeSync } from "node:fs";
import { Effect } from "effect";
import { acquireAdvisoryLockAt } from "../../../src/lock.ts";
import { NativeLockLoader, nativeLock } from "../../../src/native-lock.ts";

export type HolderPhase = "opened" | "locked" | "recorded";

const sentinel = process.argv[2];
const modeArg = process.argv[3] ?? "exclusive";
const resource = process.argv[4];
const phase = process.env.LANDO_TEST_LOCK_PAUSE_AT;
if (sentinel === undefined || sentinel.length === 0) {
  process.stderr.write("advisory-lock-holder: missing sentinel path\n");
  process.exit(2);
}
if (modeArg !== "exclusive" && modeArg !== "shared") {
  process.stderr.write(`advisory-lock-holder: invalid mode ${modeArg}\n`);
  process.exit(2);
}

const privateFileAccess = {
  enforce: async () => undefined,
  verify: async () => undefined,
};

const pause = (at: "opened" | "locked") => {
  if (phase !== at) return;
  writeSync(1, `ready ${process.pid} - ${at}\n`);
  readSync(0, Buffer.alloc(1), 0, 1, null);
};

const load = async () => {
  const open = await nativeLock();
  return (path: string) => {
    const handle = open(path);
    pause("opened");
    return {
      ...handle,
      tryLock: (mode: "exclusive" | "shared") => {
        const result = handle.tryLock(mode);
        if (result === "acquired") pause("locked");
        return result;
      },
    };
  };
};

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const lock = yield* acquireAdvisoryLockAt(sentinel, "advisory-lock-holder", {
        privateFileAccess,
        mode: modeArg,
        timeoutMs: 30_000,
        ...(resource === undefined ? {} : { resource }),
      });
      process.stdout.write(`ready ${process.pid} ${lock.token}${phase === "recorded" ? " recorded" : ""}\n`);
      // Hold until the parent closes stdin (or the process is killed).
      yield* Effect.promise(() => Bun.stdin.text());
      process.stdout.write("released\n");
    }).pipe(
      Effect.provideService(NativeLockLoader, phase === "opened" || phase === "locked" ? load : nativeLock),
    ),
  ),
);
