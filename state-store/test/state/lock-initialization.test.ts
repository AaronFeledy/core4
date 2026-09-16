import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { acquireAdvisoryLockAt } from "../../src/lock.ts";
import { ownerOnlyFileAccess } from "../private-file-access.ts";

for (const method of ["chmod", "writeFile"] as const) {
  for (const replaced of [false, true]) {
    test(`cleans only its created lock after ${method} failure with replacement=${replaced}`, async () => {
      // Given an injected filesystem failure, optionally after an inode replacement
      const dir = await fs.mkdtemp(join(tmpdir(), "lando-lock-init-"));
      const path = join(dir, "transaction.lock");
      const originalOpen = fs.open;
      const injected = new Error("injected lock initialization failure");
      const openSpy = spyOn(fs, "open").mockImplementation(async (...args: Parameters<typeof fs.open>) => {
        const handle = await originalOpen(...args);
        if (args[0] === path) {
          spyOn(handle, method).mockImplementation(async () => {
            if (replaced) {
              await fs.rename(path, join(dir, "original"));
              await fs.writeFile(path, "foreign");
            }
            throw injected;
          });
        }
        return handle;
      });
      try {
        // When initialization fails after exclusive creation
        const result = await Effect.runPromise(
          Effect.either(acquireAdvisoryLockAt(path, "test", { privateFileAccess: ownerOnlyFileAccess })),
        );
        // Then the failure is surfaced and cleanup is bounded to the original inode
        expect(result._tag).toBe("Left");
        if (result._tag === "Left") expect(result.left.cause).toBe(injected);
        if (replaced) expect(await fs.readFile(path, "utf8")).toBe("foreign");
        else await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        openSpy.mockRestore();
        await fs.rm(dir, { recursive: true, force: true });
      }
    });
  }
}

test("restricts a lock before writing its ownership record", async () => {
  // Given an owner-only access observer for a new lock
  const dir = await fs.mkdtemp(join(tmpdir(), "lando-lock-init-"));
  const path = join(dir, "transaction.lock");
  const observed: string[] = [];
  try {
    // When the lock is acquired
    const acquired = await Effect.runPromise(
      acquireAdvisoryLockAt(path, "test", {
        privateFileAccess: {
          enforce: async (created) => {
            observed.push(await fs.readFile(created, "utf8"));
          },
          verify: async () => {
            observed.push("verified");
          },
        },
      }),
    );

    // Then access was restricted while the lock was empty
    expect(observed).toEqual([""]);
    expect(JSON.parse(await fs.readFile(path, "utf8"))).toMatchObject({ token: acquired.token });
    await Effect.runPromise(acquired.release);
    expect(observed).toEqual(["", "verified"]);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("removes its empty lock when access restriction fails", async () => {
  // Given an owner-only access operation that fails
  const dir = await fs.mkdtemp(join(tmpdir(), "lando-lock-init-"));
  const path = join(dir, "transaction.lock");
  const injected = new Error("injected ACL failure");
  try {
    // When lock initialization applies access restrictions
    const result = await Effect.runPromise(
      Effect.either(
        acquireAdvisoryLockAt(path, "test", {
          privateFileAccess: {
            enforce: () => Promise.reject(injected),
            verify: () => Promise.resolve(),
          },
        }),
      ),
    );

    // Then the failure is surfaced and the poisoned empty lock is removed
    expect(result).toMatchObject({ _tag: "Left", left: { cause: injected } });
    await expect(fs.stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
