/**
 * Child process (source or compiled) that holds an advisory lock until stdin EOF.
 *
 * Protocol (stdout lines):
 *   ready <pid> <token>
 *   released
 * stderr is diagnostics only; nonzero exit is a fixture failure.
 *
 * argv: <sentinelPath> [exclusive|shared] [resource]
 */
import { Effect } from "effect";
import { acquireAdvisoryLockAt } from "../../../src/lock.ts";

const sentinel = process.argv[2];
const modeArg = process.argv[3] ?? "exclusive";
const resource = process.argv[4];
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

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const lock = yield* acquireAdvisoryLockAt(sentinel, "advisory-lock-holder", {
        privateFileAccess,
        mode: modeArg,
        timeoutMs: 30_000,
        ...(resource === undefined ? {} : { resource }),
      });
      process.stdout.write(`ready ${process.pid} ${lock.token}\n`);
      // Hold until the parent closes stdin (or the process is killed).
      yield* Effect.promise(() => Bun.stdin.text());
      process.stdout.write("released\n");
    }),
  ),
);
