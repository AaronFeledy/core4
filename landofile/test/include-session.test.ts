import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";
import { resolveLandofileIncludes } from "../src/includes.ts";
import { loadAuthoredDocuments } from "../src/root-compile.ts";
import { loadLandofileFile, loadLandofileLayers, validateLandofileReplacement } from "../src/service.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

let root = "";
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-include-session-"));
});
afterEach(() => rm(root, { recursive: true, force: true }));

const includes = [{ source: "github:acme/shared", path: "fragment.yml", version: "main" }];
const source = "includes:\n  - source: github:acme/shared\n    path: fragment.yml\n    version: main\n";
const fixture = () => {
  const acquisitions: string[] = [];
  const publications: string[] = [];
  const store = makeTestLandofileStateStore();
  const ports = makeTestLandofilePorts(join(root, "cache"));
  return {
    acquisitions,
    publications,
    inputs: {
      templates: { modules: [] },
      stateStore: {
        ...store,
        withLock: <A, E, R>(key: string, body: Effect.Effect<A, E, R>) =>
          Effect.flatMap(Effect.context<R>(), (context) => {
            publications.push(key);
            return store.withLock(key, Effect.provide(body, context));
          }),
      },
      ports: {
        ...ports,
        git: {
          clone: async ({ dest }: { readonly dest: string }) => {
            const revision = (acquisitions.length === 0 ? "a" : "b").repeat(40);
            acquisitions.push(revision);
            await mkdir(dest, { recursive: true });
            await writeFile(
              join(dest, "fragment.yml"),
              `services:\n  web:\n    image: alpine:${acquisitions.length}\n`,
            );
            await writeFile(join(dest, "other.yml"), "services:\n  database:\n    image: postgres:17\n");
            return { commitSha: revision };
          },
        },
      },
    },
  };
};

test.each(["load", "candidate"] as const)(
  "read-only %s never acquires or publishes an unpinned remote include",
  async (entry) => {
    const { inputs, acquisitions, publications } = fixture();
    const file = join(root, ".lando.yml");
    const content = `name: preview\n${source}`;
    await writeFile(file, content);
    const readOnly = { ...inputs, readOnly: true };
    const result =
      entry === "load"
        ? await Effect.runPromise(loadLandofileLayers(root, file, readOnly).pipe(Effect.result))
        : await Effect.runPromise(
            validateLandofileReplacement({ appRoot: root, targetFile: file, content }, readOnly).pipe(
              Effect.result,
            ),
          );
    expect(result._tag).toBe("Failure");
    expect(acquisitions).toEqual([]);
    expect(publications).toEqual([]);
    expect(await Bun.file(join(root, ".lando.lock.yml")).exists()).toBe(false);
    expect(await Bun.file(join(root, "cache")).exists()).toBe(false);
  },
);

test.each([false, true])(
  "shares provisional revisions across candidate layers without attempting publication (invalid=%s)",
  async (invalid) => {
    // Given: both layers request the same moving source, without an existing pin.
    const { inputs, acquisitions, publications } = fixture();
    await writeFile(join(root, ".lando.yml"), "name: original\n");
    await writeFile(join(root, ".lando.local.yml"), `${source}${invalid ? "runtime: wrong\n" : ""}`);
    // When
    const result = await Effect.runPromise(
      validateLandofileReplacement(
        { appRoot: root, targetFile: join(root, ".lando.yml"), content: `name: candidate\n${source}` },
        inputs,
      ).pipe(Effect.result),
    );
    // Then: the second layer cannot acquire a different moving revision.
    expect(acquisitions).toEqual(["a".repeat(40)]);
    expect(Result.isFailure(result)).toBe(invalid);
    expect(publications).toEqual([]);
    expect(await Bun.file(join(root, ".lando.lock.yml")).exists()).toBe(false);
  },
);

test.each(["load", "candidate"] as const)(
  "rejects cross-layer selector conflicts during %s",
  async (entry) => {
    // Given
    const { inputs, acquisitions, publications } = fixture();
    const file = join(root, ".lando.yml");
    const content = `name: conflict\n${source}`;
    await writeFile(file, content);
    await writeFile(
      join(root, ".lando.local.yml"),
      "includes:\n  - source: github:acme/shared@next\n    path: ./fragment.yml\n",
    );
    // When
    const result =
      entry === "load"
        ? await Effect.runPromise(loadLandofileLayers(root, file, inputs).pipe(Effect.result))
        : await Effect.runPromise(
            validateLandofileReplacement({ appRoot: root, targetFile: file, content }, inputs).pipe(
              Effect.result,
            ),
          );
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: {
        _tag: "LandofileIncludeError",
        kind: "source-unresolved",
        source: "github:acme/shared/fragment.yml",
      },
    });
    expect(acquisitions).toEqual(["a".repeat(40)]);
    expect(publications).toEqual([]);
    expect(await Bun.file(join(root, ".lando.lock.yml")).exists()).toBe(false);
  },
);

test("reuses a normalized same-version request across ordinary root layers", async () => {
  // Given
  const { inputs, acquisitions, publications } = fixture();
  const file = join(root, ".lando.yml");
  await writeFile(file, `name: reused\n${source}`);
  await writeFile(
    join(root, ".lando.local.yml"),
    "includes:\n  - source: github:acme/shared@main\n    path: ./fragment.yml\n",
  );
  // When
  const compiled = await Effect.runPromise(loadLandofileLayers(root, file, inputs));
  // Then
  expect(compiled.document.services).toMatchObject({ web: { image: "alpine:1" } });
  expect(acquisitions).toEqual(["a".repeat(40)]);
  expect(publications).toHaveLength(1);
});

test.each([
  { version: "main", revision: "a", acquired: 1, published: 1 },
  { version: "next", revision: "b", acquired: 2, published: 2 },
])("shares the requested $version revision across layers with an existing pin", async (expected) => {
  // Given: a persisted main pin from an earlier invocation.
  const { inputs, acquisitions, publications } = fixture();
  const file = join(root, ".lando.yml");
  await writeFile(file, `name: pinned\n${source}`);
  await Effect.runPromise(loadLandofileLayers(root, file, inputs));
  const request = source.replace("version: main", `version: ${expected.version}`);
  await writeFile(file, `name: pinned\n${request}`);
  await writeFile(join(root, ".lando.local.yml"), request);
  // When
  const compiled = await Effect.runPromise(loadLandofileLayers(root, file, inputs));
  // Then: matching pins are retained; changed selectors acquire and publish only once.
  expect(compiled.document.services).toMatchObject({ web: { image: `alpine:${expected.acquired}` } });
  expect(acquisitions).toHaveLength(expected.acquired);
  expect(publications).toHaveLength(expected.published);
  expect(Bun.YAML.parse(await Bun.file(join(root, ".lando.lock.yml")).text())).toMatchObject({
    includes: [
      {
        source: "github:acme/shared/fragment.yml",
        version: expected.version,
        resolved: expected.revision.repeat(40),
      },
    ],
  });
});

test.each([
  { remote: "github:acme/shared", path: "other.yml" },
  { remote: "github:acme/independent", path: "fragment.yml" },
])("allows independent source/path versions across layers: %s", async ({ remote, path }) => {
  // Given
  const { inputs, acquisitions, publications } = fixture();
  const file = join(root, ".lando.yml");
  await writeFile(file, `name: independent\n${source}`);
  await writeFile(
    join(root, ".lando.local.yml"),
    `includes:\n  - source: ${remote}@next\n    path: ${path}\n`,
  );
  // When
  await Effect.runPromise(loadLandofileLayers(root, file, inputs));
  // Then
  expect(acquisitions).toEqual(["a".repeat(40), "b".repeat(40)]);
  expect(publications).toHaveLength(1);
  expect(Bun.YAML.parse(await Bun.file(join(root, ".lando.lock.yml")).text())).toMatchObject({
    includes: expect.arrayContaining([
      {
        source: "github:acme/shared/fragment.yml",
        version: "main",
        resolved: "a".repeat(40),
        checksum: expect.any(String),
      },
      {
        source: `${remote}/${path}`,
        version: "next",
        resolved: "b".repeat(40),
        checksum: expect.any(String),
      },
    ]),
  });
});

for (const entry of ["root", "file", "authored", "direct"] as const) {
  test.each([false, true])(
    `${entry} publishes pins only after valid finalization (invalid=%s)`,
    async (invalid) => {
      // Given: acquisition succeeds, but the effective runtime can still be invalid.
      const { inputs, publications } = fixture();
      const file = join(root, ".lando.yml");
      const value = { name: "publication", includes, ...(invalid ? { runtime: "wrong" } : {}) };
      await writeFile(file, `name: publication\n${source}${invalid ? "runtime: wrong\n" : ""}`);
      const load = () => {
        switch (entry) {
          case "root":
            return loadLandofileLayers(root, file, inputs);
          case "file":
            return loadLandofileFile(file, undefined, inputs);
          case "authored":
            return loadAuthoredDocuments([{ file, value }], { appRoot: root, file }, inputs);
          case "direct":
            return resolveLandofileIncludes({ landofile: value, appRoot: root, ...inputs });
        }
      };
      // When
      const result = await Effect.runPromise(load().pipe(Effect.result));
      // Then
      expect(Result.isFailure(result)).toBe(invalid);
      expect(publications).toHaveLength(invalid ? 0 : 1);
      expect(await Bun.file(join(root, ".lando.lock.yml")).exists()).toBe(!invalid);
    },
  );
}
