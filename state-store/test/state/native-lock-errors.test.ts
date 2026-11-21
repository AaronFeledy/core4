import { dlopen, ptr, read, toArrayBuffer } from "bun:ffi";
import { describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { constants } from "node:os";
import { Effect } from "effect";
import { acquireAdvisoryLockAt } from "../../src/lock.ts";
import { NativeLockLoader, posix, windows } from "../../src/native-lock.ts";
import { lockTestAccess } from "./lock-test-access.ts";
import {
  acquireExclusive,
  removeDir,
  runWithScope,
  sentinelPath,
  tempLockDir,
} from "./native-lock-support.ts";

const win32 = process.platform === "win32";
const errno = constants.errno;

const fakeNativeSymbols = (status: number, recover = false) => {
  let attempts = 0;
  const fail = () => ++attempts === 1 || !recover;
  const errnoCell = new Int32Array([status]);
  let lastError = 0;
  const open = win32
    ? windows({
        ptr,
        dlopen: new Proxy(dlopen, {
          apply: () => ({
            symbols: {
              CreateFileW: () => {
                lastError = 183; // ERROR_ALREADY_EXISTS: the test creates the sentinel.
                return 1n;
              },
              GetFileInformationByHandle: (_handle: bigint, info: ReturnType<typeof ptr>) => {
                new DataView(toArrayBuffer(info, 0, 52)).setUint32(40, 1, true);
                return 1;
              },
              LockFileEx: () => {
                lastError = status;
                return fail() ? 0 : 1;
              },
              UnlockFileEx: () => 1,
              CloseHandle: () => 1,
              GetLastError: () => lastError,
            },
          }),
        }),
      })
    : posix(
        {
          read,
          dlopen: new Proxy(dlopen, {
            apply: () => ({
              symbols: {
                flock: (_fd: number, flags: number) => (flags !== 8 && fail() ? -1 : 0),
                __error: () => ptr(errnoCell),
                __errno_location: () => ptr(errnoCell),
              },
            }),
          }),
        },
        process.platform === "darwin",
      );
  return { load: async () => open, attempts: () => attempts };
};

describe("native advisory lock error classification", () => {
  const fatal = win32
    ? ([
        ["ERROR_INVALID_FUNCTION", 1],
        ["ERROR_NOT_LOCKED", 158],
      ] as const)
    : ([
        ["ENOLCK", errno.ENOLCK],
        ["EOPNOTSUPP", errno.EOPNOTSUPP],
      ] as const);

  for (const [name, status] of fatal) {
    test(`${name} fails closed without retrying`, async () => {
      const dir = await tempLockDir();
      const sentinel = sentinelPath(dir);
      try {
        await writeFile(sentinel, "", { mode: 0o600 });
        const { load, attempts } = fakeNativeSymbols(status);
        const error = await runWithScope(
          Effect.flip(acquireExclusive(sentinel, { timeoutMs: 30_000 })).pipe(
            Effect.provideService(NativeLockLoader, load),
            Effect.timeout(2_000),
          ),
        );
        expect(error).toMatchObject({ _tag: "StateStoreError", reason: "lock" });
        expect(error.lockFailure).toBeUndefined();
        expect(error.remediation).toMatch(/keep Lando data roots on a local disk/i);
        expect(attempts()).toBe(1);
      } finally {
        await removeDir(dir);
      }
    });
  }

  // EINTR is a POSIX flock result, not a LockFileEx status.
  test.skipIf(win32)("EINTR retries within the budget and acquires", async () => {
    const dir = await tempLockDir();
    const sentinel = sentinelPath(dir);
    try {
      const { load, attempts } = fakeNativeSymbols(errno.EINTR, true);
      await runWithScope(
        acquireExclusive(sentinel, { timeoutMs: 2_000 }).pipe(Effect.provideService(NativeLockLoader, load)),
      );
      expect(attempts()).toBe(2);
    } finally {
      await removeDir(dir);
    }
  });

  test(`${win32 ? "ERROR_LOCK_VIOLATION" : "EWOULDBLOCK"} enters the contention path`, async () => {
    const dir = await tempLockDir();
    const sentinel = sentinelPath(dir);
    try {
      await writeFile(
        sentinel,
        JSON.stringify({ pid: process.pid, token: "holder", createdAt: Date.now() }),
        {
          mode: 0o600,
        },
      );
      const { load } = fakeNativeSymbols(win32 ? 33 : errno.EWOULDBLOCK);
      const error = await runWithScope(
        Effect.flip(
          acquireAdvisoryLockAt(sentinel, "test", {
            privateFileAccess: lockTestAccess,
            timeoutMs: 0,
            refuseOnContention: (record) => Effect.succeed(record.token === "holder"),
          }),
        ).pipe(Effect.provideService(NativeLockLoader, load)),
      );
      expect(error).toMatchObject({ _tag: "StateStoreError", reason: "lock", lockFailure: "refused" });
    } finally {
      await removeDir(dir);
    }
  });
});
