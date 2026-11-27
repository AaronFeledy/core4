import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyVerifiedSourcePatches } from "../../../scripts/linux-podman-source-build.ts";
import {
  type RuntimeBundleSourcePatch,
  runtimeBundlePatchPath,
} from "../../../scripts/runtime-bundle-sources.ts";
import { patchedSource, upstreamSource } from "./netavark-patch-fixture.ts";

const sha256 = (value: string | Uint8Array): string => createHash("sha256").update(value).digest("hex");

const pinnedNetavarkPatch = async (
  files: RuntimeBundleSourcePatch["files"],
): Promise<RuntimeBundleSourcePatch> => {
  const pin = { file: "scripts/patches/netavark-v2.0.0-systemd-user-bus.patch", sha256: "", files };
  return { ...pin, sha256: sha256(await readFile(runtimeBundlePatchPath(pin))) };
};

const executePatch = async (command: ReadonlyArray<string>, cwd?: string): Promise<void> => {
  const process =
    cwd === undefined
      ? Bun.spawn([...command], { stdout: "pipe", stderr: "pipe" })
      : Bun.spawn([...command], { cwd, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stderr] = await Promise.all([process.exited, new Response(process.stderr).text()]);
  if (exitCode !== 0) throw new Error(`patch failed with exit ${exitCode}: ${stderr}`);
};

const withSourceDir = async (run: (sourceDir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "source-patch-"));
  try {
    await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

// Stands in for `patch`: edits one file and creates another, as the Podman patches do.
const modified = "modified\n";
const created = "created\n";
const fakePatch =
  (calls: string[]) =>
  async (_command: ReadonlyArray<string>, cwd?: string): Promise<void> => {
    calls.push("patch");
    if (cwd === undefined) throw new Error("patch requires cwd");
    await writeFile(join(cwd, "a.go"), modified);
    await writeFile(join(cwd, "b.go"), created);
  };

const twoFilePins = (after: string = created) =>
  pinnedNetavarkPatch([
    { path: "a.go", sourceSha256: sha256("original\n"), patchedSha256: sha256(modified) },
    { path: "b.go", patchedSha256: sha256(after) },
  ]);

describe("verified source patches", () => {
  test("applies the checked-in Netavark user-bus patch with exact before and after hashes", () =>
    withSourceDir(async (sourceDir) => {
      const sourcePath = join(sourceDir, "src", "dns", "aardvark.rs");
      await mkdir(join(sourceDir, "src", "dns"), { recursive: true });
      await writeFile(sourcePath, upstreamSource);
      const patch = await pinnedNetavarkPatch([
        {
          path: "src/dns/aardvark.rs",
          sourceSha256: sha256(upstreamSource),
          patchedSha256: sha256(patchedSource),
        },
      ]);

      await applyVerifiedSourcePatches({ sourceDir, patches: [patch], execute: executePatch });

      expect(await readFile(sourcePath, "utf8")).toBe(patchedSource);
    }));

  test("verifies a modified file and a created file", () =>
    withSourceDir(async (sourceDir) => {
      await writeFile(join(sourceDir, "a.go"), "original\n");
      const calls: string[] = [];
      await applyVerifiedSourcePatches({
        sourceDir,
        patches: [await twoFilePins()],
        execute: fakePatch(calls),
      });
      expect(calls).toEqual(["patch"]);
    }));

  test.each([
    ["a modified file drifted", "drift", /source SHA-256 mismatch before patching a\.go/u],
    ["a created file already exists", "exists", /creates b\.go, which already exists/u],
    ["the patch bytes differ from the pin", "patch", /patch SHA-256 mismatch/u],
  ] as const)("rejects before patching when %s", (_name, damage, message) =>
    withSourceDir(async (sourceDir) => {
      await writeFile(join(sourceDir, "a.go"), damage === "drift" ? "drifted\n" : "original\n");
      if (damage === "exists") await writeFile(join(sourceDir, "b.go"), created);
      const pins = await twoFilePins();
      const patch = damage === "patch" ? { ...pins, sha256: "c".repeat(64) } : pins;
      const calls: string[] = [];
      const result = applyVerifiedSourcePatches({ sourceDir, patches: [patch], execute: fakePatch(calls) });
      await expect(result).rejects.toThrow(message);
      expect(calls).toEqual([]);
    }),
  );

  test("rejects a patched file that differs from its pin", () =>
    withSourceDir(async (sourceDir) => {
      await writeFile(join(sourceDir, "a.go"), "original\n");
      const result = applyVerifiedSourcePatches({
        sourceDir,
        patches: [await twoFilePins("other\n")],
        execute: fakePatch([]),
      });
      await expect(result).rejects.toThrow(/patched source SHA-256 mismatch for b\.go/u);
    }));
});
