import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { ADVISORY_LOCK_SUFFIX, acquireAdvisoryLockAt } from "../../src/lock.ts";
import { lockTestAccess } from "./lock-test-access.ts";

const sentinelFor = (dir: string) => join(dir, `transaction${ADVISORY_LOCK_SUFFIX}`);

test("restricts a newly created lock before writing its ownership record", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "lando-lock-init-"));
  const path = sentinelFor(dir);
  const observed: string[] = [];
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const acquired = yield* acquireAdvisoryLockAt(path, "test", {
            privateFileAccess: {
              enforce: async (created) => {
                observed.push(await fs.readFile(created, "utf8"));
              },
              verify: async () => {
                observed.push("verified");
              },
            },
          });
          // enforce runs on create while the sentinel is still empty; record is written after lock.
          expect(observed[0]).toBe("");
          expect(observed).toContain("verified");
          const record = yield* Effect.promise(async () => JSON.parse(await fs.readFile(path, "utf8")));
          expect(record).toMatchObject({ token: acquired.token });
        }),
      ),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("surfaces access-restriction failure without leaving a held lock", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "lando-lock-init-"));
  const path = sentinelFor(dir);
  const injected = new Error("injected ACL failure");
  try {
    const result = await Effect.runPromise(
      Effect.result(
        Effect.scoped(
          acquireAdvisoryLockAt(path, "test", {
            privateFileAccess: {
              enforce: () => Promise.reject(injected),
              verify: () => Promise.resolve(),
            },
          }),
        ),
      ),
    );
    expect(result._tag).toBe("Failure");
    // A later acquire with healthy access must succeed (no stuck kernel hold).
    await Effect.runPromise(
      Effect.scoped(
        acquireAdvisoryLockAt(path, "test", {
          privateFileAccess: lockTestAccess,
          timeoutMs: 1_000,
        }),
      ),
    );
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("reuses an existing sentinel without re-running enforce", async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), "lando-lock-init-"));
  const path = sentinelFor(dir);
  await fs.writeFile(path, "", { mode: 0o600 });
  const observed: string[] = [];
  try {
    await Effect.runPromise(
      Effect.scoped(
        acquireAdvisoryLockAt(path, "test", {
          privateFileAccess: {
            enforce: async () => {
              observed.push("enforce");
            },
            verify: async () => {
              observed.push("verified");
            },
          },
        }),
      ),
    );
    expect(observed).toEqual(["verified"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
