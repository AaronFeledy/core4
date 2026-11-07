import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceName } from "@lando/sdk/schema";
import { Effect } from "effect";
import { prepareLandofileReplacement } from "../src/service.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "lando-prepared-replacement-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});
const prepare = (root: string) =>
  Effect.runPromise(
    prepareLandofileReplacement(
      {
        appRoot: root,
        targetFile: join(root, ".lando.dist.yml"),
        content: "name: global\nruntime: 4\nservices:\n  mail:\n    type: compose\n    image: mail:v1\n",
      },
      {
        ports: makeTestLandofilePorts(directory),
        stateStore: makeTestLandofileStateStore(),
        templates: { modules: [] },
      },
    ),
  );

test("prepares a nonexistent root without guard recovery, files, or directories", async () => {
  const root = join(directory, "absent");
  const prepared = await prepare(root);
  await Effect.runPromise(prepared.verify);
  expect(prepared.landofile.document.services?.[ServiceName.make("mail")]?.image).toBe("mail:v1");
  expect(await readdir(directory)).toEqual([]);
});

test("refuses a virtual generated YAML layer when its TypeScript form already exists", async () => {
  await writeFile(join(directory, ".lando.dist.ts"), 'export default { name: "global" };\n');

  await expect(prepare(directory)).rejects.toMatchObject({ _tag: "LandofileFormConflictError" });

  expect(await Bun.file(join(directory, ".lando.dist.yml")).exists()).toBe(false);
});

test("rejects an authored layer introduced after preparation", async () => {
  const prepared = await prepare(directory);
  await writeFile(join(directory, ".lando.local.yml"), "name: changed\n");
  expect((await Effect.runPromise(Effect.result(prepared.verify)))._tag).toBe("Failure");
});

test("rejects a same-byte authored symlink retarget after preparation", async () => {
  const left = join(directory, "left.yml");
  const right = join(directory, "right.yml");
  const canonical = join(directory, ".lando.yml");
  await writeFile(left, "name: global\n");
  await writeFile(right, "name: global\n");
  await symlink(left, canonical);
  const prepared = await prepare(directory);
  await unlink(canonical);
  await symlink(right, canonical);
  expect((await Effect.runPromise(Effect.result(prepared.verify)))._tag).toBe("Failure");
});

test("rejects referenced include bytes changed after compilation", async () => {
  const fragment = join(directory, "fragment.yml");
  await writeFile(fragment, "services:\n  custom:\n    type: compose\n    image: custom:v1\n");
  await writeFile(join(directory, ".lando.yml"), "includes: [fragment.yml]\n");
  const prepared = await prepare(directory);
  await writeFile(fragment, "services:\n  custom:\n    type: compose\n    image: custom:v2\n");
  expect((await Effect.runPromise(Effect.result(prepared.verify)))._tag).toBe("Failure");
});

test("rejects an absent root materialized through a different physical parent", async () => {
  const first = join(directory, "first");
  const second = join(directory, "second");
  const alias = join(directory, "alias");
  await mkdir(first);
  await mkdir(second);
  await symlink(first, alias);
  const prepared = await prepare(join(alias, "global"));
  await unlink(alias);
  await symlink(second, alias);
  expect((await Effect.runPromise(Effect.result(prepared.verify)))._tag).toBe("Failure");
});
