import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isLandofileOverride, override } from "@lando/sdk/landofile";
import { ConfigTranslateSourceId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { runRecipeInitPipeline } from "../../src/recipes/init-pipeline.ts";
import { recipeInitReview, snapshotRecipeInitData } from "../../src/recipes/prepared-init-types.ts";
import { prepareRecipeInit } from "../../src/recipes/prepared-init.ts";
import { pipelineSourceFixture } from "./fixtures/pipeline-source.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "init-review-data-"));
  roots.push(root);
  return pipelineSourceFixture(root, {});
};
const attack = (value: unknown): void => {
  if (value === null || typeof value !== "object") return;
  expect(Object.isFrozen(value)).toBe(true);
  for (const key of Reflect.ownKeys(value)) {
    const entry: unknown = Reflect.get(value, key);
    expect(Reflect.set(value, key, "mutated")).toBe(false);
    expect(Reflect.deleteProperty(value, key)).toBe(false);
    attack(entry);
  }
};

test("review retains typed expression ASTs and detaches every public nested value", async () => {
  // Given
  const f = await fixture();
  const prepared = await Effect.runPromise(prepareRecipeInit(f.request));
  if (prepared.status !== "ready") throw new Error("Missing fixture answers");
  const preview = JSON.stringify(prepared.preview);
  const bytes = prepared.outputs.map(({ content }) => content);
  // When
  const review = recipeInitReview(prepared);
  attack(review);
  attack(prepared.preview);
  attack(prepared.source);
  attack(prepared.actions);
  attack(prepared.answers);
  const result = await Effect.runPromise(
    runRecipeInitPipeline({ ...f.publication, prepared, postInitEnabled: false }),
  );
  // Then
  expect(Object.keys(review).sort()).toEqual([
    "actions",
    "appName",
    "appRoot",
    "diagnostics",
    "outputs",
    "skippedScaffold",
    "source",
  ]);
  expect(review.source).toMatchObject({
    name: "chosen-name",
    services: {
      app: {
        type: { _tag: "AuthoringExpression", form: "composite", template: { whole: false } },
        webroot: "web",
      },
    },
  });
  expect(review.source).not.toBe(prepared.source);
  expect(review.outputs).not.toBe(prepared.preview.outputs);
  expect(JSON.stringify(prepared.preview)).toBe(preview);
  for (const [index, output] of prepared.outputs.entries()) {
    const original = bytes[index];
    if (original === undefined) throw new Error("Missing approved output");
    expect(Array.from(await Bun.file(join(prepared.appRoot, output.destination)).bytes())).toEqual(
      Array.from(original),
    );
  }
  expect(result.receipt.created).toHaveLength(prepared.outputs.length);
});

test("encoder-retained references cannot mutate validated context or later preview diagnostics", async () => {
  // Given
  const f = await fixture();
  const encode = f.request.encoder.encode;
  if (encode === undefined) throw new Error("Missing encoder");
  const keyPath = ["services", "app"];
  let mutate = () => {};
  // When
  const prepared = await Effect.runPromise(
    prepareRecipeInit({
      ...f.request,
      encoder: {
        ...f.request.encoder,
        encode: (input) =>
          Effect.map(encode(input), (encoded) => {
            expect(Reflect.set(input.context, "name", "encoder-mutated")).toBe(false);
            mutate = () => {
              expect(Reflect.set(input.context, "name", "late-mutated")).toBe(false);
            };
            return {
              ...encoded,
              diagnostics: [
                {
                  kind: "needs-review",
                  sourceId: ConfigTranslateSourceId.make("fixture"),
                  keyPath,
                  message: "fixture",
                },
              ],
            };
          }),
      },
    }),
  );
  if (prepared.status !== "ready") throw new Error("Missing fixture answers");
  keyPath.push("late");
  mutate();
  // Then
  expect(prepared.source).toMatchObject({ name: "chosen-name" });
  expect(prepared.diagnostics.find(({ sourceId }) => sourceId === "fixture")?.keyPath).toEqual([
    "services",
    "app",
  ]);
  expect(prepared.preview.landofile).toContain("name: chosen-name");
});

test("snapshot preserves symbol-keyed directives without freezing the original data", () => {
  // Given
  const original = { nested: [override({ value: ["literal"] })] };
  // When
  const copy = snapshotRecipeInitData(original);
  original.nested.push(override({ value: ["later"] }));
  // Then
  expect(copy.nested).toHaveLength(1);
  expect(isLandofileOverride(copy.nested[0])).toBe(true);
  expect(copy.nested[0]?.value).toEqual({ value: ["literal"] });
  attack(copy);
});

test("raw init-only answers never enter the allowlisted review", async () => {
  // Given
  const f = await fixture();
  const secret = "PRIVATE_REVIEW_CANARY_43f8";
  const { compileTestSource, testSource } = await import("./fixtures/prepared-source.ts");
  const compiled = await compileTestSource(
    {
      ...testSource,
      options: {
        token: { type: { kind: "secret" }, disposition: { kind: "init-only", sink: { kind: "stdin" } } },
      },
      postInit: [{ type: "bun", verb: "install", stdin: { prompt: "token" } }],
    },
    f.root,
  );
  // When
  const prepared = await Effect.runPromise(
    prepareRecipeInit({ ...f.request, compiled, secretAnswers: { token: secret } }),
  );
  if (prepared.status !== "ready") throw new Error("Missing fixture answers");
  const review = recipeInitReview(prepared);
  // Then
  expect(JSON.stringify(review)).not.toContain(secret);
  expect(review.actions).toEqual([{ index: 0, type: "bun", authorized: true }]);
  expect(Object.hasOwn(review, "secretAnswers")).toBe(false);
  expect(Object.hasOwn(review, "compiled")).toBe(false);
  expect(Object.hasOwn(review, "preview")).toBe(false);
  expect(Object.hasOwn(review, "redact")).toBe(false);
});
