import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
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
  const runner: Pick<ProcessRunner["Type"], "streamWithExit"> = {
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
