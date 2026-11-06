import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareRuntimeBundleArchives } from "../../../scripts/check-runtime-bundle-reproducibility.ts";

/** Packs `files` the way the assembler does, with `mtime` as the only knob for metadata-only differences. */
const pack = async (
  root: string,
  name: string,
  files: Record<string, string>,
  mtime = "@0",
): Promise<Uint8Array<ArrayBuffer>> => {
  const stage = join(root, name);
  for (const [path, body] of Object.entries(files)) {
    await mkdir(join(stage, path, ".."), { recursive: true });
    await writeFile(join(stage, path), body);
  }
  const archive = join(root, `${name}.tar.gz`);
  await Bun.$`tar --format=gnu --sort=name --mtime=${mtime} --owner=0 --group=0 --numeric-owner -cf - -C ${stage} . | gzip -n -9 > ${archive}`.quiet();
  return readFile(archive);
};

const withRoot = async (run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "rb-repro-"));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("runtime bundle reproducibility comparison", () => {
  test("accepts byte-identical rebuilds", async () => {
    await withRoot(async (root) => {
      const files = { "bin/podman": "podman", "bin/licenses/podman/LICENSE": "license" };
      const comparison = compareRuntimeBundleArchives(
        await pack(root, "a", files),
        await pack(root, "b", files),
      );
      expect(comparison).toEqual({ identical: true, differingMembers: [] });
    });
  });

  test("names members whose bytes differ or exist in only one archive", async () => {
    await withRoot(async (root) => {
      const reference = await pack(root, "a", { "bin/podman": "podman", "bin/netavark": "build-a" });
      const rebuild = await pack(root, "b", {
        "bin/podman": "podman",
        "bin/netavark": "build-b",
        "bin/extra": "x",
      });
      expect(compareRuntimeBundleArchives(reference, rebuild)).toEqual({
        identical: false,
        differingMembers: ["./bin/extra", "./bin/netavark"],
      });
    });
  });

  test("reports a metadata-only difference without blaming any member", async () => {
    await withRoot(async (root) => {
      const files = { "bin/podman": "podman" };
      const comparison = compareRuntimeBundleArchives(
        await pack(root, "a", files),
        await pack(root, "b", files, "@86400"),
      );
      expect(comparison).toEqual({ identical: false, differingMembers: [] });
    });
  });
});
