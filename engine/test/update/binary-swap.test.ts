import { afterEach, expect, test } from "bun:test";
import { chmod, link, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { binarySwapFileSystem, swapBinary } from "../../src/update/binary-swap.ts";
import { UpdatePermissionError } from "../../src/update/errors.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const oldBinary = "#!/bin/sh\nprintf old\\n\n";
const newBinary = "#!/bin/sh\nprintf new\\n\n";
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-binary-swap-"));
  roots.push(root);
  const paths = {
    executablePath: join(root, "lando"),
    stagedBinaryPath: join(root, "candidate"),
    backupPath: join(root, "lando.bak"),
  };
  await writeFile(paths.executablePath, oldBinary, { mode: 0o751 });
  await writeFile(paths.stagedBinaryPath, newBinary, { mode: 0o755 });
  return paths;
};
const permissionError = (message: string, cause: unknown) =>
  new UpdatePermissionError({ message, cause, remediation: "Restore the retained backup." });
const options = {
  fs: binarySwapFileSystem,
  error: permissionError,
  rollbackError: (error: unknown, cause: unknown) =>
    permissionError("Rollback failed", { failure: error, rollbackFailure: cause }),
};

test.each([
  { failure: "none", fallback: false, installed: newBinary },
  { failure: "none", fallback: true, installed: newBinary },
  { failure: "remove", fallback: false, installed: oldBinary },
  { failure: "stat", fallback: true, installed: oldBinary },
  { failure: "copy", fallback: true, installed: oldBinary },
  { failure: "chmod", fallback: true, installed: oldBinary },
  { failure: "replace", fallback: false, installed: oldBinary },
  { failure: "verify", fallback: false, installed: oldBinary },
  { failure: "verify", fallback: true, installed: oldBinary },
  { failure: "rollback", fallback: false, installed: newBinary },
])("self-update keeps a runnable executable at every boundary ($failure, copy=$fallback)", async (row) => {
  const paths = await fixture();
  const observations: { bytes: string; mode: number }[] = [];
  const reached: string[] = [];
  const injected = new Error(`injected ${row.failure}`);
  const observe = async () => {
    observations.push({
      bytes: await readFile(paths.executablePath, "utf8"),
      mode: (await stat(paths.executablePath)).mode & 0o777,
    });
  };
  const step = async <A>(name: string, action: () => Promise<A>): Promise<A> => {
    reached.push(name);
    await observe();
    if (row.failure === name) {
      // Model a failed copy that has already left a partial destination.
      if (name === "copy") await writeFile(paths.backupPath, "partial", { mode: 0o600 });
      throw injected;
    }
    const result = await action();
    await observe();
    return result;
  };
  const fs = {
    remove: (path: string) => step("remove", () => binarySwapFileSystem.remove(path)),
    link: (from: string, to: string) =>
      step("link", async () => {
        if (row.fallback) throw new Error("hardlinks unsupported");
        await binarySwapFileSystem.link(from, to);
      }),
    stat: (path: string) => step("stat", () => binarySwapFileSystem.stat(path)),
    copy: (from: string, to: string) => step("copy", () => binarySwapFileSystem.copy(from, to)),
    chmod: (path: string, mode: number) => step("chmod", () => binarySwapFileSystem.chmod(path, mode)),
    rename: (from: string, to: string) =>
      step(from === paths.backupPath ? "rollback" : "replace", () => binarySwapFileSystem.rename(from, to)),
  };
  const verify = Effect.tryPromise({
    try: () =>
      step("verify", async () => {
        if (row.failure === "rollback") throw injected;
      }),
    catch: (cause) => permissionError("Verification failed", cause),
  });

  const outcome = await Effect.runPromise(Effect.result(swapBinary(paths, verify, { ...options, fs })));

  expect(Result.isSuccess(outcome)).toBe(row.failure === "none");
  expect(await readFile(paths.executablePath, "utf8")).toBe(row.installed);
  expect(observations.length).toBeGreaterThan(0);
  for (const observation of observations) {
    expect([oldBinary, newBinary]).toContain(observation.bytes);
    expect(observation.mode).toBe(observation.bytes === oldBinary ? 0o751 : 0o755);
  }
  if (row.failure !== "none") expect(reached).toContain(row.failure);
  if (row.failure === "none" || row.failure === "rollback") {
    expect(await readFile(paths.backupPath, "utf8")).toBe(oldBinary);
    expect((await stat(paths.backupPath)).mode & 0o777).toBe(0o751);
  }
  if (row.failure === "none") expect(reached.includes("copy")).toBe(row.fallback);
  if (row.failure === "rollback") {
    if (Result.isSuccess(outcome)) throw new Error("Expected rollback failure");
    expect(outcome.failure.message).toBe("Rollback failed");
  }
});

test.each([false, true])(
  "self-update replaces a stale backup without writing through its inode (copy=%s)",
  async (fallback) => {
    const paths = await fixture();
    await link(paths.executablePath, paths.backupPath);
    const failure = permissionError("Verification failed", undefined);

    const outcome = await Effect.runPromise(
      Effect.result(
        swapBinary(paths, Effect.fail(failure), {
          ...options,
          fs: {
            ...binarySwapFileSystem,
            link: async (from, to) => {
              if (fallback) throw new Error("hardlinks unsupported");
              await link(from, to);
            },
            copy: async (from, to) => {
              await binarySwapFileSystem.copy(from, to);
              await chmod(to, 0o600);
            },
          },
        }),
      ),
    );

    if (Result.isSuccess(outcome)) throw new Error("Expected verification failure");
    expect(outcome.failure).toBe(failure);
    expect(await readFile(paths.executablePath, "utf8")).toBe(oldBinary);
    expect((await stat(paths.executablePath)).mode & 0o777).toBe(0o751);
  },
);
