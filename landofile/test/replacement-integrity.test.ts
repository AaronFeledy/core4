import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { loadLandofileLayers, validateLandofileReplacement } from "../src/service.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-candidate-integrity-"));
  await mkdir(join(root, "app"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const content = (version = "main") =>
  `name: candidate\nincludes:\n  - source: github:acme/shared\n    path: fragment.yml\n    version: ${version}\n`;
const inputs = () => ({
  ports: {
    ...makeTestLandofilePorts(join(root, "cache")),
    git: {
      clone: async ({ dest, ref }: { readonly dest: string; readonly ref?: string }) => {
        await mkdir(dest, { recursive: true });
        await writeFile(join(dest, "fragment.yml"), "services:\n  web:\n    image: alpine\n");
        return { commitSha: (ref === "next" ? "b" : "a").repeat(40) };
      },
    },
  },
  stateStore: makeTestLandofileStateStore(),
  templates: { modules: [] },
});
const replace = (candidate: string) =>
  validateLandofileReplacement(
    { appRoot: join(root, "app"), targetFile: join(root, "app/.lando.yml"), content: candidate },
    inputs(),
  );
const load = () => loadLandofileLayers(join(root, "app"), join(root, "app/.lando.yml"), inputs());

test.each([false, true])(
  "leaves the app tree unchanged for a remote candidate (rejected=%s)",
  async (rejected) => {
    // Given
    const original = "name: original\n";
    await writeFile(join(root, "app/.lando.yml"), original);
    if (rejected) await writeFile(join(root, "app/.lando.local.yml"), "runtime: wrong\n");
    // When
    const result = await Effect.runPromise(replace(content()).pipe(Effect.result));
    // Then
    expect(Result.isFailure(result)).toBe(rejected);
    expect(await readdir(join(root, "app"))).toEqual(
      rejected ? [".lando.local.yml", ".lando.yml"] : [".lando.yml"],
    );
    expect(await Bun.file(join(root, "app/.lando.yml")).text()).toBe(original);
  },
);

test("preserves an existing pin when a candidate changes the version", async () => {
  // Given
  await writeFile(join(root, "app/.lando.yml"), content());
  await Effect.runPromise(load());
  const before = await Bun.file(join(root, "app/.lando.lock.yml")).text();
  // When
  await Effect.runPromise(replace(content("next")));
  // Then
  expect(await Bun.file(join(root, "app/.lando.lock.yml")).text()).toBe(before);
});

test("preserves existing lock bytes when effective validation rejects a new version", async () => {
  // Given
  await writeFile(join(root, "app/.lando.yml"), content());
  await Effect.runPromise(load());
  const before = await Bun.file(join(root, "app/.lando.lock.yml")).text();
  await writeFile(join(root, "app/.lando.local.yml"), "runtime: wrong\n");
  // When
  const result = await Effect.runPromise(replace(content("next")).pipe(Effect.result));
  // Then
  expect(Result.isFailure(result)).toBe(true);
  expect(await Bun.file(join(root, "app/.lando.lock.yml")).text()).toBe(before);
});

test("ordinary loads still publish pins", async () => {
  // Given
  await writeFile(join(root, "app/.lando.yml"), content());
  // When
  await Effect.runPromise(load());
  // Then
  expect(await Bun.file(join(root, "app/.lando.lock.yml")).text()).toContain(`resolved: ${"a".repeat(40)}`);
});

test.each(["corrupt", "checksum"] as const)("rejects a candidate with a %s lock", async (kind) => {
  // Given
  await writeFile(join(root, "app/.lando.yml"), content());
  await Effect.runPromise(load());
  const lock = join(root, "app/.lando.lock.yml");
  const before = await Bun.file(lock).text();
  const damaged =
    kind === "corrupt"
      ? "invalid lock\n"
      : before.replace(/checksum: [a-f0-9]+/u, `checksum: ${"0".repeat(64)}`);
  await writeFile(lock, damaged);
  // When
  const result = await Effect.runPromise(replace(content()).pipe(Effect.result));
  // Then
  expect(Result.isFailure(result)).toBe(true);
  expect(await Bun.file(lock).text()).toBe(damaged);
});
