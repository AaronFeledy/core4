import { expect, test } from "bun:test";
import { mkdtemp, open, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessRunner } from "@lando/sdk/services";
import { Effect, Stream } from "effect";

test("exports only public material and preserves binary bytes with readable permissions", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "gpg-keyring-"));
  const destDir = join(root, "keyring");
  const calls: ReadonlyArray<string>[] = [];
  const bytes = new Uint8Array([0x99, 0xff, 0x00, 0x80]);
  const runner: Pick<ProcessRunner["Service"], "streamWithExit"> = {
    streamWithExit: ({ args }) => {
      calls.push(args);
      return Stream.make({ kind: "stdout" as const, chunk: bytes }, { exitCode: 0 });
    },
  };
  try {
    const { exportPublicKeyring } = await import("../../../src/subsystems/gpg-agent/keyring.ts");
    // When
    await Effect.runPromise(exportPublicKeyring({ runner, destDir }));
    // Then
    expect(calls).toEqual([
      ["--batch", "--export"],
      ["--batch", "--export-ownertrust"],
    ]);
    expect(calls.flat().some((arg) => arg.includes("--export-secret"))).toBe(false);
    expect(new Uint8Array(await readFile(join(destDir, "pubring.gpg")))).toEqual(bytes);
    expect((await stat(destDir)).mode & 0o777).toBe(0o711);
    for (const file of ["pubring.gpg", "otrust.txt"])
      expect((await stat(join(destDir, file))).mode & 0o777).toBe(0o644);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("refreshes an existing keyring atomically on each export", async () => {
  // Given
  const root = await mkdtemp(join(tmpdir(), "gpg-keyring-refresh-"));
  const destDir = join(root, "keyring");
  const { exportPublicKeyring } = await import("../../../src/subsystems/gpg-agent/keyring.ts");
  let bytes = new Uint8Array([1, 2, 3]);
  const runner: Pick<ProcessRunner["Service"], "streamWithExit"> = {
    streamWithExit: () => Stream.make({ kind: "stdout" as const, chunk: bytes }, { exitCode: 0 }),
  };
  try {
    await Effect.runPromise(exportPublicKeyring({ runner, destDir }));
    const old = await open(join(destDir, "pubring.gpg"), "r");
    try {
      bytes = new Uint8Array([4, 5]);
      // When
      await Effect.runPromise(exportPublicKeyring({ runner, destDir }));
      // Then: an open reader sees the old inode, while new readers see the refresh.
      expect(new Uint8Array(await old.readFile())).toEqual(new Uint8Array([1, 2, 3]));
      for (const file of ["pubring.gpg", "otrust.txt"]) {
        expect(new Uint8Array(await readFile(join(destDir, file)))).toEqual(bytes);
        expect((await stat(join(destDir, file))).mode & 0o777).toBe(0o644);
      }
      expect((await stat(destDir)).mode & 0o777).toBe(0o711);
      expect((await readdir(destDir)).sort()).toEqual(["otrust.txt", "pubring.gpg"]);
    } finally {
      await old.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
