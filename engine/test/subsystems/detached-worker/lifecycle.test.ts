import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Schema } from "effect";
import {
  type WorkerClaim,
  WorkerClaimError,
  changeWorkerClaim,
  planWorkerClaim,
  withDetachedWorkerLock,
} from "../../../src/subsystems/detached-worker/claim.ts";
import { acquireWorker, terminateWorker } from "../../../src/subsystems/detached-worker/lifecycle.ts";
import {
  readDetachedWorkerRecord,
  writeDetachedWorkerRecord,
} from "../../../src/subsystems/detached-worker/state-file.ts";

const RecordSchema = Schema.Struct({ pid: Schema.Number, sessionId: Schema.String });
const record = { pid: 12345, sessionId: "owned" };
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-worker-lifecycle-"));
  const path = join(root, "worker.json");
  const options = {
    path,
    label: "test-worker",
    paths: { userDataRoot: root },
    privateFileAccess: { enforce: async () => undefined, verify: async () => undefined },
  };
  return {
    path,
    lock: <A, E>(body: (claim: WorkerClaim) => Effect.Effect<A, E>) => withDetachedWorkerLock(options, body),
    write: (claim: WorkerClaim) =>
      writeDetachedWorkerRecord(claim, { ...options, schema: RecordSchema }, record),
    read: readDetachedWorkerRecord(path, RecordSchema),
    remove: Effect.promise(() => rm(path, { force: true })),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

test("a published claim cannot be overwritten or spawned over", async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(f.lock(f.write));
    const result = await Effect.runPromise(f.lock((claim) => Effect.result(f.write(claim))));
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "WorkerClaimError" } });
    expect(planWorkerClaim("spawn", "ready")._tag).toBe("Illegal");
    expect(await Effect.runPromise(f.read)).toEqual(record);
  } finally {
    await f.cleanup();
  }
});

test("stopping refuses publication and reuse without executing their effects", async () => {
  const f = await fixture();
  let reused = false;
  try {
    await Effect.runPromise(f.lock(f.write));
    const results = await Effect.runPromise(
      f.lock(
        Effect.fnUntraced(function* (claim) {
          yield* changeWorkerClaim(claim, "stop", Effect.void);
          return [
            yield* Effect.result(f.write(claim)),
            yield* Effect.result(
              changeWorkerClaim(
                claim,
                "reuse",
                Effect.sync(() => {
                  reused = true;
                }),
              ),
            ),
          ];
        }),
      ),
    );
    expect(results.map((result) => result._tag)).toEqual(["Failure", "Failure"]);
    expect(reused).toBe(false);
    expect(await Effect.runPromise(f.read)).toEqual(record);
  } finally {
    await f.cleanup();
  }
});

test.each([false, true])(
  "termination reaps a claim with owned=%s and only signals an owner",
  async (owned) => {
    const f = await fixture();
    let signaled = false;
    try {
      await Effect.runPromise(f.lock(f.write));
      await Effect.runPromise(
        f.lock((claim) =>
          terminateWorker({
            claim,
            owned: Effect.succeed(owned),
            shutdown: Effect.sync(() => {
              signaled = true;
            }),
            remove: f.remove,
          }),
        ),
      );
      expect(signaled).toBe(owned);
      expect(await Effect.runPromise(f.read)).toBeUndefined();
    } finally {
      await f.cleanup();
    }
  },
);

test("failed termination retains the claim for a later locked attempt", async () => {
  const f = await fixture();
  try {
    await Effect.runPromise(f.lock(f.write));
    const result = await Effect.runPromise(
      f.lock((claim) =>
        Effect.result(
          terminateWorker({
            claim,
            owned: Effect.succeed(true),
            shutdown: Effect.fail("exit timeout"),
            remove: f.remove,
          }),
        ),
      ),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: "exit timeout" });
    expect(await Effect.runPromise(f.read)).toEqual(record);
  } finally {
    await f.cleanup();
  }
});

test("replace reaps a dead claim before publishing its replacement, then reuse leaves it intact", async () => {
  const f = await fixture();
  let spawns = 0;
  let terminations = 0;
  const worker = {
    pid: record.pid,
    argv: [],
    logPath: join(f.path, "log"),
    writeStdin: async () => undefined,
    readReady: async () => record,
    terminate: async () => {
      terminations++;
    },
  };
  const acquire = (reuse: boolean) =>
    f.lock((claim) =>
      acquireWorker({
        claim,
        reuse: reuse ? f.read : Effect.succeed(undefined),
        replace: terminateWorker({
          claim,
          owned: Effect.succeed(false),
          shutdown: Effect.die("foreign signal"),
          remove: f.remove,
        }),
        spawn: Effect.sync(() => {
          spawns++;
          return worker;
        }),
        prepare: () => Effect.succeed({ session: record, persist: f.write(claim) }),
        publish: () => Effect.void,
      }),
    );
  try {
    await Effect.runPromise(f.lock(f.write));
    await Effect.runPromise(acquire(false));
    await Effect.runPromise(acquire(true));
    expect(spawns).toBe(1);
    expect(terminations).toBe(0);
    expect(await Effect.runPromise(f.read)).toEqual(record);
  } finally {
    await f.cleanup();
  }
});

test("startup failure releases the child and reaps unpublished crash artifacts on the next attempt", async () => {
  const f = await fixture();
  const artifact = `${f.path}.socket`;
  let terminated = false;
  const worker = {
    pid: record.pid,
    argv: [],
    logPath: `${f.path}.log`,
    writeStdin: async () => undefined,
    readReady: async () => record,
    terminate: async () => {
      terminated = true;
    },
  };
  try {
    const result = await Effect.runPromise(
      f.lock((claim) =>
        Effect.result(
          acquireWorker({
            claim,
            reuse: Effect.succeed(undefined),
            replace: changeWorkerClaim(claim, "reap-stale", f.remove),
            spawn: Effect.promise(async () => {
              await Bun.write(artifact, "leftover");
              return worker;
            }),
            prepare: () =>
              Effect.fail(new WorkerClaimError({ message: "readiness failed", remediation: "test" })),
            publish: () => Effect.void,
          }),
        ),
      ),
    );
    expect(result).toMatchObject({ _tag: "Failure", failure: { message: "readiness failed" } });
    expect(terminated).toBe(true);
    expect(await Effect.runPromise(f.read)).toBeUndefined();
    await Effect.runPromise(
      f.lock((claim) =>
        changeWorkerClaim(
          claim,
          "reap-stale",
          Effect.promise(() => rm(artifact)),
        ),
      ),
    );
    expect(await Bun.file(artifact).exists()).toBe(false);
  } finally {
    await f.cleanup();
  }
});

test("a claim that escapes its lock cannot overwrite a newer owner", async () => {
  const f = await fixture();
  try {
    // Given: a claim returned out of its lock body, then a newer owner publishing under a fresh lock
    const escaped = await Effect.runPromise(f.lock((claim) => Effect.succeed(claim)));
    await Effect.runPromise(f.lock(f.write));
    await Effect.runPromise(f.remove);
    // When: the released claim tries to publish
    const result = await Effect.runPromise(Effect.result(f.write(escaped)));
    // Then: it is refused and writes nothing
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "WorkerClaimError" } });
    expect(await Effect.runPromise(f.read)).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test("concurrent publications through one claim advance it only once", async () => {
  const f = await fixture();
  try {
    // When: two publications race through the same held claim
    const results = await Effect.runPromise(
      f.lock((claim) =>
        Effect.all([Effect.result(f.write(claim)), Effect.result(f.write(claim))], {
          concurrency: "unbounded",
        }),
      ),
    );
    // Then: exactly one succeeds
    expect(results.map((result) => result._tag).sort()).toEqual(["Failure", "Success"]);
  } finally {
    await f.cleanup();
  }
});
