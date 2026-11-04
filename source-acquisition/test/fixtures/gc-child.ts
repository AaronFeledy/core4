/**
 * Cross-process GC lease holder.
 *
 * argv: <storeRoot> <archiveSha256>
 * Env: inherits parent process; StateStore roots are derived like makeTestSourceStore
 * (userCacheRoot = dirname(storeRoot)).
 *
 * Protocol:
 * 1. Open a real SourceStore session and register the archive key (lease held).
 * 2. Write exactly one line `GC_CHILD_READY` to stdout and flush.
 * 3. Hold until one byte arrives on stdin, then exit 0 (lease released on scope close).
 */
import { dirname, join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { makeStateStore } from "@lando/state-store/service";
import { Effect } from "effect";
import { makeSourceStore } from "../../src/index.ts";

const storeRoot = process.argv[2];
const sha256 = process.argv[3];
if (storeRoot === undefined || sha256 === undefined || !/^[a-f\d]{64}$/u.test(sha256)) {
  process.stderr.write("usage: gc-child.ts <storeRoot> <archiveSha256>\n");
  process.exit(2);
}

const cacheRoot = dirname(storeRoot);
const stateStore = makeStateStore({
  roots: makeLandoPaths({
    userCacheRoot: cacheRoot,
    userDataRoot: join(cacheRoot, "data"),
    userConfRoot: join(cacheRoot, "conf"),
    systemPluginRoot: join(cacheRoot, "system"),
  }).roots,
  privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
});

const store = makeSourceStore({
  stateStore,
  transports: {},
});

const waitForStdinByte = (): Promise<void> =>
  new Promise((resolve, reject) => {
    const onData = (): void => {
      cleanup();
      resolve();
    };
    const onEnd = (): void => {
      cleanup();
      resolve();
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      process.stdin.off("data", onData);
      process.stdin.off("end", onEnd);
      process.stdin.off("error", onError);
    };
    process.stdin.on("data", onData);
    process.stdin.on("end", onEnd);
    process.stdin.on("error", onError);
    process.stdin.resume();
  });

await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* store.session;
      const snap = yield* session.openArchive(sha256);
      if (snap === undefined) {
        return yield* Effect.fail(new Error(`archive ${sha256} missing in child`));
      }
      process.stdout.write("GC_CHILD_READY\n");
      yield* Effect.promise(() => waitForStdinByte());
    }),
  ),
);
