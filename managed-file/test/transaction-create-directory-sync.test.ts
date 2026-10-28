import { expect, spyOn, test } from "bun:test";
import { constants } from "node:fs";
import { readFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Effect } from "effect";
import { fixture, scoped } from "./transaction-fixture.ts";

const directoryFdOpen = (flags: unknown): boolean =>
  typeof flags === "number" && (flags & constants.O_DIRECTORY) !== 0;

const eperm = (): Error => Object.assign(new Error("directory sync refused"), { code: "EPERM" });

const posixAccess = (): Promise<PrivateFileAccess> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        return yield* PrivateFileAccessService;
      }).pipe(Effect.provide(PrivateFileAccessService.layerWithOptions({ platform: "linux" }))),
    ),
  );

const withDirectorySync = async (
  platform: "linux" | "win32",
  onDirectorySync: (sync: () => Promise<void>) => Promise<void>,
  body: () => Promise<unknown>,
): Promise<{ readonly directorySyncs: number; readonly fileSyncs: number }> => {
  const originalPlatform = process.platform;
  const originalOpen = fs.open;
  let directorySyncs = 0;
  let fileSyncs = 0;
  const open = spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
    const handle = await originalOpen(path, flags, mode);
    const stats = await handle.stat();
    if (stats.isDirectory() && directoryFdOpen(flags)) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        directorySyncs += 1;
        await onDirectorySync(sync);
      };
    } else if (stats.isFile()) {
      const sync = handle.sync.bind(handle);
      handle.sync = async () => {
        fileSyncs += 1;
        await sync();
      };
    }
    return handle;
  });
  try {
    Object.defineProperty(process, "platform", { value: platform });
    await body();
  } finally {
    open.mockRestore();
    Object.defineProperty(process, "platform", { value: originalPlatform });
  }
  return { directorySyncs, fileSyncs };
};

test.skipIf(process.platform !== "linux")(
  "fsyncs the pinned publication directory and the file descriptor",
  async () => {
    // Given an existing parent so publication is the only directory-fd sync
    const marker = "PINNED-DIRECTORY-SYNC";
    const { appRoot, transactions } = await fixture();

    // When create commits on Linux
    const synced = await withDirectorySync(
      "linux",
      (sync) => sync(),
      () =>
        scoped(
          transactions.run({
            appRoot,
            operations: [{ kind: "create", path: "index.html", content: marker }],
          }),
        ),
    );

    // Then the already-open directory fd is synced, not only a path reopen, and the file is synced too
    expect(synced.directorySyncs).toBeGreaterThan(0);
    expect(synced.fileSyncs).toBeGreaterThan(0);
    expect(await readFile(join(appRoot, "index.html"), "utf8")).toBe(marker);
  },
);

test.skipIf(process.platform !== "linux")(
  "publishes a nested create on win32 without directory fsync",
  async () => {
    // Given Windows directory fsync failing EPERM and POSIX access captured before the platform spoof
    const marker = "WIN32-NESTED-BYTES";
    const access = await posixAccess();
    const { appRoot, transactions } = await fixture(undefined, access);

    // When publication runs under the win32 platform policy
    const synced = await withDirectorySync(
      "win32",
      () => Promise.reject(eperm()),
      () =>
        scoped(
          transactions.run({
            appRoot,
            operations: [{ kind: "create", path: "nested/deep/file.txt", content: marker, mode: 0o644 }],
          }),
        ),
    );

    // Then the create lands, the file descriptor was synced, and no directory fd sync ran
    expect(synced.directorySyncs).toBe(0);
    expect(synced.fileSyncs).toBeGreaterThan(0);
    expect(await readFile(join(appRoot, "nested/deep/file.txt"), "utf8")).toBe(marker);
    expect(((await fs.lstat(join(appRoot, "nested/deep/file.txt"))).mode & 0o200) !== 0).toBe(true);
  },
);

test.skipIf(process.platform !== "linux")("does not swallow a directory fsync failure on linux", async () => {
  // Given a pinned directory sync that fails
  const { appRoot, transactions } = await fixture();
  let result: { readonly _tag: string; readonly failure?: { readonly reason: string } } | undefined;

  // When publication hits that failure
  await withDirectorySync(
    "linux",
    () => Promise.reject(eperm()),
    async () => {
      const outcome = await scoped(
        Effect.result(
          transactions.run({
            appRoot,
            operations: [{ kind: "create", path: "nested/file.txt", content: "SHOULD-NOT-COMMIT" }],
          }),
        ),
      );
      result = outcome;
    },
  );

  // Then the filesystem error stays a failure
  expect(result?._tag).toBe("Failure");
  expect(result?.failure?.reason).toBe("io");
});
