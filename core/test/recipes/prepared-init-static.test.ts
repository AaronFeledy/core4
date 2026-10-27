import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plugin } from "@lando/lando4";
import type { RecipeFile, RecipePostInitAction } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { prepareRecipeInit } from "../../src/recipes/prepared-init.ts";
import { compileTestSource, testSource } from "./fixtures/prepared-source.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async (content: Uint8Array) => {
  const root = await mkdtemp(join(tmpdir(), "prepared-static-"));
  roots.push(root);
  await Bun.write(join(root, "asset"), content);
  const compiled = await compileTestSource(
    {
      ...testSource,
      options: {
        required: { type: { kind: "string" } },
        enabled: { type: { kind: "boolean" }, default: false },
      },
      files: [{ src: "asset", dest: "asset" }],
    },
    root,
  );
  const loader = plugin.configTranslators?.get("lando4");
  if (loader === undefined) throw new Error("Missing encoder");
  return {
    root,
    request: { compiled, appRoot: join(root, "app"), appName: "café", answers: {}, encoder: await loader() },
  };
};

const invalidFiles = [
  [{ src: "asset", dest: "../escape" }],
  [{ src: "asset", dest: ".lando.yml" }],
  [{ src: "asset", dest: ".lando.ts" }],
  [{ src: "asset", dest: ".lando.yml/child" }],
  [{ src: "asset", dest: ".lando.ts/child" }],
  [
    { src: "asset", dest: "dir" },
    { src: "asset", dest: "nested/../dir/file" },
  ],
  [
    { src: "asset", dest: "dir/file" },
    { src: "asset", dest: "dir" },
  ],
  [{ src: "asset", dest: "asset", mode: "08" }],
  [{ src: "asset", dest: "asset", mode: "1777" }],
  [{ src: "asset", dest: "asset", template: true }],
  [
    { src: "asset", dest: "asset" },
    { src: "asset", dest: "nested/../asset" },
  ],
] satisfies readonly (readonly RecipeFile[])[];

test.each(invalidFiles)(
  "rejects invalid static files before returning missing answers: %j",
  async (...files) => {
    // Given a compiled observation and an unanswered required option.
    const f = await fixture(new Uint8Array([0xff]));
    const observed = f.request.compiled.files[0];
    if (observed === undefined) throw new Error("Missing observed fixture file");
    // When preparation receives an invalid static declaration.
    const result = await Effect.runPromise(
      Effect.result(
        prepareRecipeInit({
          ...f.request,
          compiled: { ...f.request.compiled, files: files.map((value) => ({ ...observed, value })) },
        }),
      ),
    );
    // Then static validation fails rather than reporting readiness or creating output.
    expect(Result.isFailure(result) && result.failure).toMatchObject({
      _tag: "RecipeInitBlockedError",
      stage: "validate",
    });
    expect(await readdir(f.root)).toEqual(["asset"]);
  },
);

const invalidActions = [
  { type: "bun", verb: "add", dependencies: ["--global"] },
  { type: "bun", verb: "add", devDependencies: ["--cwd=/outside"] },
  { type: "bun", verb: "add", peerDependencies: ["--global"] },
  { type: "bun", verb: "add", optionalDependencies: ["--cwd=/outside"] },
  { type: "bun", verb: "add", dependencies: [] },
  { type: "bun", verb: "run", script: "--cwd=/outside" },
  { type: "bun", verb: "script", script: "--cwd=/outside" },
  { type: "bun", verb: "run", script: "  " },
  { type: "bun", verb: "create", template: "--global" },
  { type: "bun", verb: "x", spec: "--cwd=/outside" },
  { type: "gitInit" },
] satisfies readonly RecipePostInitAction[];

test.each(invalidActions)("rejects invalid actions before missing answers: %j", async (value) => {
  // Given an unanswered required option and an otherwise compiled recipe.
  const f = await fixture(new Uint8Array());
  const observed = f.request.compiled.files[0];
  if (observed === undefined) throw new Error("Missing observed fixture file");
  // When an invalid action reaches the shared read-only preparation boundary.
  const result = await Effect.runPromise(
    Effect.result(
      prepareRecipeInit({
        ...f.request,
        compiled: { ...f.request.compiled, postInit: [{ ...observed, value }] },
      }),
    ),
  );
  // Then it fails before output directories or publication state can be created.
  expect(Result.isFailure(result) && result.failure).toMatchObject({ stage: "validate" });
  expect(await readdir(f.root)).toEqual(["asset"]);
});

test.each([{ enabled: "false" }, { unknown: "answer" }])(
  "rejects invalid supplied answers while another answer is missing: %j",
  async (answers) => {
    // Given
    const f = await fixture(new Uint8Array([0xff]));
    // When
    const result = await Effect.runPromise(Effect.result(prepareRecipeInit({ ...f.request, answers })));
    // Then
    expect(Result.isFailure(result) && result.failure).toMatchObject({ stage: "validate" });
  },
);

test("previews rendered byte lengths while keeping prepared and observed bytes isolated", async () => {
  // Given
  const original = new TextEncoder().encode("\uFEFF{{ app.name }}\r\n");
  const f = await fixture(original);
  const compiled = await compileTestSource(
    { ...testSource, files: [{ src: "asset", dest: "bin/run", template: true, mode: "0755" }] },
    f.root,
  );
  // When
  const prepared = await Effect.runPromise(prepareRecipeInit({ ...f.request, compiled }));
  if (prepared.status !== "ready") throw new Error("Unexpected missing answers");
  const output = prepared.outputs[1];
  if (output === undefined) throw new Error("Missing prepared fixture file");
  output.content.fill(0);
  compiled.files[0]?.content.fill(0);
  // Then
  expect(output.content).toEqual(new TextEncoder().encode("\uFEFFcafé\r\n"));
  expect(prepared.preview.outputs[1]).toMatchObject({ destination: "bin/run", mode: 0o755, bytes: 10 });
  expect(compiled.files[0]?.content).toEqual(original);
  expect(await readdir(f.root)).toEqual(["asset"]);
});
