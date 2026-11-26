import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  readRuntimeBundleSources,
  runtimeBundlePatchPath,
  runtimeBundlePatchSetDigest,
  sourcePatchesOf,
} from "../../../scripts/runtime-bundle-sources.ts";

const repoRoot = resolve(import.meta.dir, "../../..");

test("every pinned source patch matches its committed bytes", async () => {
  const sources = await readRuntimeBundleSources();
  const patches = Object.values(sources.bundles).flatMap((group) =>
    group.components.flatMap(sourcePatchesOf),
  );
  expect(patches.length).toBeGreaterThan(0);
  for (const patch of patches) {
    const bytes = await readFile(runtimeBundlePatchPath(patch));
    expect({ file: patch.file, sha256: createHash("sha256").update(bytes).digest("hex") }).toEqual({
      file: patch.file,
      sha256: patch.sha256,
    });
  }
});

test("patch inputs change only with a runtime version bump", async () => {
  const sources = await readRuntimeBundleSources();
  const record = JSON.parse(
    await readFile(join(repoRoot, "scripts/patches/runtime-patch-sets.json"), "utf8"),
  ) as {
    readonly patchSets: Readonly<Record<string, string>>;
  };
  const versions = Object.keys(record.patchSets).sort((a, b) => Bun.semver.order(a, b));
  expect(versions.at(-1)).toBe(sources.runtimeVersion);
  const digest = runtimeBundlePatchSetDigest(sources);
  if (record.patchSets[sources.runtimeVersion] !== digest) {
    throw new Error(
      `Runtime ${sources.runtimeVersion} records patch set ${record.patchSets[sources.runtimeVersion]}, but its source patches now hash to ${digest}. Bump runtimeVersion in plugins/provider-lando/runtime-bundle-sources.json and record ${digest} under the new version in scripts/patches/runtime-patch-sets.json; update an existing entry only while that version is unpublished.`,
    );
  }
});
