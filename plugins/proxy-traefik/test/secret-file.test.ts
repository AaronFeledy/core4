import { expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writeSecretAtomic } from "../src/secret-file.ts";

test("writes secret files atomically with owner-only permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "lando-secret-file-"));
  try {
    const path = join(directory, "proxy.key");

    await writeSecretAtomic(path, "private key");

    expect((await stat(path)).mode & 0o777).toBe(0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves the primary failure when temporary-file cleanup also fails", async () => {
  const primary = new Error("rename failed");

  await expect(
    writeSecretAtomic("/unused/proxy.key", "private key", {
      randomId: () => "test",
      writeFile: async () => undefined,
      renameFile: async () => {
        throw primary;
      },
      removeFile: async () => {
        throw new Error("cleanup failed");
      },
    }),
  ).rejects.toBe(primary);
});
