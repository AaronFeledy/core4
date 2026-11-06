import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as BunFileSystem from "@lando/engine/services/file-system";
import { FileIoError, FileNotFoundError, FilePermissionError } from "@lando/sdk/errors";
import { FileSystem } from "@lando/sdk/services";
import { Effect } from "effect";
import { makeReadLockKeys } from "../../src/operations/source-cache-gc.ts";

const withTemp = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-source-cache-gc-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test("readLockKeys reports missing, unreadable, corrupt, and ok lock keys", async () => {
  await withTemp(async (dir) => {
    const liveFs = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* FileSystem;
      }).pipe(Effect.provide(BunFileSystem.layer)),
    );

    const missing = await Effect.runPromise(makeReadLockKeys(liveFs)(join(dir, "absent.lock.yml")));
    expect(missing).toEqual({ status: "missing" });

    const permissionFs = FileSystem.of({
      ...liveFs,
      readText: () =>
        Effect.fail(
          new FilePermissionError({
            message: "permission denied",
            path: join(dir, "secret.lock.yml"),
          }),
        ),
    });
    const unreadable = await Effect.runPromise(makeReadLockKeys(permissionFs)(join(dir, "secret.lock.yml")));
    expect(unreadable).toEqual({ status: "unreadable", detail: "permission denied" });

    const ioFs = FileSystem.of({
      ...liveFs,
      readText: () =>
        Effect.fail(
          new FileIoError({
            message: "I/O error",
            path: join(dir, "io.lock.yml"),
            remediation: "retry",
          }),
        ),
    });
    const ioResult = await Effect.runPromise(makeReadLockKeys(ioFs)(join(dir, "io.lock.yml")));
    expect(ioResult).toEqual({ status: "unreadable", detail: "I/O error" });

    // FileNotFoundError is missing, not unreadable.
    const notFoundFs = FileSystem.of({
      ...liveFs,
      readText: () =>
        Effect.fail(new FileNotFoundError({ message: "gone", path: join(dir, "gone.lock.yml") })),
    });
    expect(await Effect.runPromise(makeReadLockKeys(notFoundFs)(join(dir, "gone.lock.yml")))).toEqual({
      status: "missing",
    });

    const corruptPath = join(dir, "corrupt.lock.yml");
    await writeFile(corruptPath, "not: a lockfile\n");
    const corrupt = await Effect.runPromise(makeReadLockKeys(liveFs)(corruptPath));
    expect(corrupt).toMatchObject({ status: "corrupt" });
    if (corrupt.status === "corrupt") expect(corrupt.detail.length).toBeGreaterThan(0);

    const commit = "a".repeat(40);
    const okPath = join(dir, ".lando.lock.yml");
    await writeFile(
      okPath,
      [
        "includes:",
        "  - source: github:acme/shared/php.yml",
        `    resolved: ${commit}`,
        `    checksum: ${"b".repeat(64)}`,
        "  - source: npm:@acme/fragments/web.yml",
        "    version: latest",
        "    resolved: 1.2.3",
        `    checksum: ${"c".repeat(64)}`,
        "",
      ].join("\n"),
    );
    const ok = await Effect.runPromise(makeReadLockKeys(liveFs)(okPath));
    expect(ok).toEqual({
      status: "ok",
      keys: [
        { kind: "git", commit },
        { kind: "npm", name: "@acme/fragments", version: "1.2.3" },
      ],
    });
  });
});

test.each([
  { source: "npm:@acme/fragments/web.yml", resolved: "latest" },
  { source: "github:acme/other/base.yml", resolved: "deadbeef" },
])("readLockKeys marks $source with non-identity pin $resolved corrupt", async ({ source, resolved }) => {
  await withTemp(async (dir) => {
    const liveFs = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* FileSystem;
      }).pipe(Effect.provide(BunFileSystem.layer)),
    );
    const commit = "d".repeat(40);
    const path = join(dir, ".lando.lock.yml");
    await writeFile(
      path,
      [
        "includes:",
        "  - source: github:acme/shared/php.yml",
        `    resolved: ${commit}`,
        `    checksum: ${"e".repeat(64)}`,
        `  - source: ${source}`,
        "    version: latest",
        `    resolved: ${resolved}`,
        `    checksum: ${"f".repeat(64)}`,
        "",
      ].join("\n"),
    );
    const result = await Effect.runPromise(makeReadLockKeys(liveFs)(path));
    expect(result.status).toBe("corrupt");
  });
});
