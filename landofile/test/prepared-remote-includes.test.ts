import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sha256Hex } from "@lando/sdk/digest";
import { Effect } from "effect";
import { acquireLandofileReplacement, prepareLandofileReplacement } from "../src/service.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

const revision = "a".repeat(40);
const fragment = "services:\n  remote:\n    type: compose\n    image: remote:v1\n";
const pin = {
  source: "github:acme/shared/fragment.yml",
  version: "main",
  resolved: revision,
  checksum: sha256Hex(fragment),
};
let directory = "";
let acquisitions: Array<string | undefined> = [];

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "lando-prepared-remote-"));
  acquisitions = [];
  await mkdir(join(directory, "app"));
});
afterEach(() => rm(directory, { recursive: true, force: true }));

const replacement = () => ({
  appRoot: join(directory, "app"),
  targetFile: join(directory, "app", ".lando.dist.yml"),
  content:
    "name: global\nruntime: 4\nincludes:\n  - source: github:acme/shared\n    path: fragment.yml\n    version: main\n",
});
const inputs = () => {
  const cacheRoot = join(directory, "cache");
  const basePorts = makeTestLandofilePorts(cacheRoot);
  return {
    templates: { modules: [] },
    stateStore: makeTestLandofileStateStore(cacheRoot),
    ports: {
      ...basePorts,
      sources: {
        ...basePorts.sources,
        git: {
          fetch: async ({ dest, ref }: { readonly dest: string; readonly ref?: string }) => {
            acquisitions.push(ref);
            await mkdir(dest, { recursive: true });
            await writeFile(join(dest, "fragment.yml"), fragment);
            return { commit: revision };
          },
        },
      },
    },
  };
};

test("acquisition retains selected proposals without publishing until explicitly committed", async () => {
  // Given
  const candidate = replacement();
  // When
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const prepared = yield* acquireLandofileReplacement(candidate, inputs());
        // Then
        expect(prepared.landofile.document.services).toMatchObject({ remote: { image: "remote:v1" } });
        expect(acquisitions).toEqual(["main"]);
        expect(yield* Effect.promise(() => readdir(candidate.appRoot))).toEqual([]);
        yield* prepared.verify;
        yield* prepared.publishIncludes;
        yield* prepared.verify;
        expect(
          Bun.YAML.parse(
            yield* Effect.promise(() => Bun.file(join(candidate.appRoot, ".lando.lock.yml")).text()),
          ),
        ).toEqual({
          includes: [pin],
        });
      }),
    ),
  );
});

test.each(["prepare", "read-only acquisition"] as const)(
  "%s cannot acquire an unpinned remote",
  async (mode) => {
    // Given
    const candidate = replacement();
    const runtime = inputs();
    // When
    const result = await Effect.runPromise(
      Effect.scoped(
        Effect.result(
          mode === "prepare"
            ? prepareLandofileReplacement(candidate, runtime)
            : acquireLandofileReplacement(candidate, { ...runtime, readOnly: true }),
        ),
      ),
    );
    // Then
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "LandofileIncludeError" } });
    expect(acquisitions).toEqual([]);
    expect(await readdir(candidate.appRoot)).toEqual([]);
    // Session may create lease/cache dirs; app tree stays empty.
  },
);

test.each([false, true])(
  "prepared acquisition detects an externally edited pin (published=%s)",
  async (published) => {
    // Given
    const candidate = replacement();
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const prepared = yield* acquireLandofileReplacement(candidate, inputs());
          if (published) yield* prepared.publishIncludes;
          yield* Effect.promise(() => writeFile(join(candidate.appRoot, ".lando.lock.yml"), "includes:\n"));
          // When
          const result = yield* Effect.result(prepared.verify);
          // Then
          expect(result).toMatchObject({
            _tag: "Failure",
            failure: { _tag: "LandofileWriteValidationError" },
          });
        }),
      ),
    );
  },
);
