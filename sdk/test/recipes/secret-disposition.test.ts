import { expect, test } from "bun:test";
import { Either } from "effect";
import {
  approvedSecretReferencesOnly,
  secretSinkFailure,
  validateRecipeSecretPrompts,
} from "../../src/recipes/secret-disposition.ts";
import type { RecipeManifest, RecipePrompt } from "../../src/schema/recipe.ts";

const prompt: RecipePrompt = {
  name: "token",
  type: "secret",
  message: "Token",
  disposition: { kind: "init-only", sink: { kind: "stdin" } },
};
const manifest = (
  prompts: ReadonlyArray<RecipePrompt>,
  postInit: RecipeManifest["postInit"] = [],
): RecipeManifest => ({ id: "php", version: "1.0.0", title: "PHP", description: "PHP", prompts, postInit });
test.each([
  ["missing", manifest([{ name: "token", type: "secret", message: "Token" }])],
  ["multiple", manifest([prompt, prompt])],
  ["default-value", manifest([{ ...prompt, default: "never-output-this" }])],
  ["sink-unresolved", manifest([prompt])],
  [
    "sink-ambiguous",
    manifest(
      [prompt],
      [
        { type: "command", cmd: "init", stdin: { prompt: "token" } },
        { type: "bun", verb: "install", stdin: { prompt: "token" } },
      ],
    ),
  ],
] as const)("secret disposition reason %s", (reason, value) => {
  const result = validateRecipeSecretPrompts(value);
  expect(Either.isLeft(result) && result.left.reason).toBe(reason);
});
test("secretEnv binds only the declared env name", () => {
  const result = validateRecipeSecretPrompts(
    manifest(
      [{ ...prompt, disposition: { kind: "init-only", sink: { kind: "secretEnv", name: "TOKEN" } } }],
      [{ type: "bun", verb: "install", secretEnv: { TOKEN: "token" } }],
    ),
  );
  expect(Either.isRight(result)).toBe(true);
});
test("secret-store requires a non-empty field", () => {
  const result = validateRecipeSecretPrompts(
    manifest([{ ...prompt, disposition: { kind: "secret-store", field: "" } }]),
  );
  expect(Either.isLeft(result) && result.left.reason).toBe("sink-unresolved");
});
test("approved references reject extra raw value fields", () => {
  const result = approvedSecretReferencesOnly({
    producer: {
      sourceKind: "bundled",
      packageName: "recipes",
      recipeId: "php",
      manifestVersion: "1.0.0",
      contentDigest: `sha256:${"a".repeat(64)}`,
    },
    options: {},
    secrets: {
      token: Object.assign({ disposition: "postInit.stdin" as const }, { value: "never-output-this" }),
    },
  });
  expect(Either.isLeft(result) && result.left.reason).toBe("invalid-secret-reference");
  expect(JSON.stringify(result)).not.toContain("never-output-this");
});
test("secretSinkFailure JSON contains only structural fields and generated diagnostics", () => {
  const params = {
    recipeId: "php",
    promptName: "token",
    sink: "postInit.stdin",
    stage: "deliver",
    message: "never-output-this",
    cause: "never-output-this",
  } as const;
  const json = JSON.parse(JSON.stringify(secretSinkFailure(params)));
  expect(Object.keys(json).sort()).toEqual([
    "_tag",
    "message",
    "promptName",
    "recipeId",
    "remediation",
    "sink",
    "stage",
  ]);
  expect(JSON.stringify(json)).not.toContain("never-output-this");
});
