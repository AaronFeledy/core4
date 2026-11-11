import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CONTAINER_HELPER_ARCHES } from "@lando/container-runtime/container-helper";
import { containerHelperSourceDigest } from "@lando/container-runtime/container-helper/source";

import { buildContainerHelperAssets } from "../../../scripts/build-compiled-binary.ts";
import { stubContainerHelperDir } from "./fixtures/container-helper-stubs.ts";

const previous = process.env.LANDO_CONTAINER_HELPER_DIR;
const cleanup: string[] = [];

afterEach(async () => {
  if (previous === undefined) Reflect.deleteProperty(process.env, "LANDO_CONTAINER_HELPER_DIR");
  else process.env.LANDO_CONTAINER_HELPER_DIR = previous;
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const embedFrom = async (sourceDigest: string | undefined) => {
  const helperDir = await stubContainerHelperDir();
  const stagingDir = await mkdtemp(join(tmpdir(), "lando-helper-assets-"));
  cleanup.push(helperDir, stagingDir);
  if (sourceDigest !== undefined) await writeFile(join(helperDir, "source-digest"), `${sourceDigest}\n`);
  process.env.LANDO_CONTAINER_HELPER_DIR = helperDir;
  return buildContainerHelperAssets(stagingDir);
};

test("Given a helper override built from older sources, when embedding it, then the compile fails with the rebuild command", async () => {
  await expect(embedFrom("0".repeat(64))).rejects.toThrow("build:container-helper");
});

test("Given a helper override built from the current sources, when embedding it, then every arch is embedded", async () => {
  expect(await embedFrom(await containerHelperSourceDigest())).toHaveLength(CONTAINER_HELPER_ARCHES.length);
});

test("Given a stub helper override without a source digest, when embedding it, then it is embedded", async () => {
  expect(await embedFrom(undefined)).toHaveLength(CONTAINER_HELPER_ARCHES.length);
});
