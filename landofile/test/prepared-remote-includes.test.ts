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
const inputs = () => ({
  templates: { modules: [] },
  stateStore: makeTestLandofileStateStore(),
  ports: {
    ...makeTestLandofilePorts(join(directory, "cache")),
    git: {
      clone: async ({ dest, ref }: { readonly dest: string; readonly ref?: string }) => {
        acquisitions.push(ref);
        await mkdir(dest, { recursive: true });
        await writeFile(join(dest, "fragment.yml"), fragment);
        return { commitSha: revision };
      },
    },
  },
});

test("acquisition retains selected proposals without publishing until explicitly committed", async () => {
  // Given
  const candidate = replacement();
  // When
  const prepared = await Effect.runPromise(acquireLandofileReplacement(candidate, inputs()));
  // Then
  expect(prepared.landofile.document.services).toMatchObject({ remote: { image: "remote:v1" } });
  expect(acquisitions).toEqual(["main"]);
  expect(await readdir(candidate.appRoot)).toEqual([]);
  await Effect.runPromise(prepared.verify);
  await Effect.runPromise(prepared.publishIncludes);
  await Effect.runPromise(prepared.verify);
  expect(Bun.YAML.parse(await Bun.file(join(candidate.appRoot, ".lando.lock.yml")).text())).toEqual({
    includes: [pin],
  });
});

test.each(["prepare", "read-only acquisition"] as const)(
  "%s cannot acquire an unpinned remote",
  async (mode) => {
    // Given
    const candidate = replacement();
    const runtime = inputs();
    // When
    const result = await Effect.runPromise(
      Effect.result(
        mode === "prepare"
          ? prepareLandofileReplacement(candidate, runtime)
          : acquireLandofileReplacement(candidate, { ...runtime, readOnly: true }),
      ),
    );
    // Then
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "LandofileIncludeError" } });
    expect(acquisitions).toEqual([]);
    expect(await readdir(candidate.appRoot)).toEqual([]);
    expect(await Bun.file(join(directory, "cache")).exists()).toBe(false);
  },
);

test.each([false, true])(
  "prepared acquisition detects an externally edited pin (published=%s)",
  async (published) => {
    // Given
    const candidate = replacement();
    const prepared = await Effect.runPromise(acquireLandofileReplacement(candidate, inputs()));
    if (published) await Effect.runPromise(prepared.publishIncludes);
    await writeFile(join(candidate.appRoot, ".lando.lock.yml"), "includes:\n");
    // When
    const result = await Effect.runPromise(Effect.result(prepared.verify));
    // Then
    expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: "LandofileWriteValidationError" } });
  },
);
