import { expect, test } from "bun:test";
import { compileRecipeSource, validateOptionValues } from "@lando/sdk/recipes";
import type { RecipeOptionType, RecipeOptionValue } from "@lando/sdk/schema";
import { Result } from "effect";
import type { PromptDriverRequest } from "../../../src/recipes/prompts/driver.ts";
import {
  collectPrompts,
  createBufferedPromptIO,
  parseAnswerFlags,
} from "../../../src/recipes/prompts/index.ts";

const cases = [
  { type: { kind: "string", pattern: "^[a-z]+$" }, invalid: "BAD", valid: "web", value: "web" },
  { type: { kind: "string", minLength: 3 }, invalid: "ab", valid: "abc", value: "abc" },
  { type: { kind: "string", maxLength: 3 }, invalid: "abcd", valid: "abc", value: "abc" },
  { type: { kind: "number", integer: true }, invalid: "1.5", valid: "2", value: 2 },
  { type: { kind: "number", min: 2 }, invalid: "1", valid: "2", value: 2 },
  { type: { kind: "number", max: 2 }, invalid: "3", valid: "2", value: 2 },
  { type: { kind: "enum", values: [false, "fast"] }, invalid: "unknown", valid: "false", value: false },
  {
    type: { kind: "array", items: { kind: "enum", values: ["a", "b", "c"] }, minItems: 2 },
    invalid: "a",
    valid: "a,b",
    value: ["a", "b"],
  },
  {
    type: { kind: "array", items: { kind: "enum", values: ["a", "b", "c"] }, maxItems: 2 },
    invalid: "a,b,c",
    valid: "a,b",
    value: ["a", "b"],
  },
  {
    type: { kind: "array", items: { kind: "number", integer: true, min: 1 } },
    invalid: "1,1.5",
    valid: "1,2",
    value: [1, 2],
  },
  {
    type: { kind: "array", items: { kind: "string", pattern: "^[a-z]+$", minLength: 2 } },
    invalid: "ok,X",
    valid: "ok,yes",
    value: ["ok", "yes"],
  },
  {
    type: { kind: "optional", inner: { kind: "number", integer: true } },
    invalid: "1.5",
    valid: "2",
    value: 2,
  },
] as const satisfies readonly {
  readonly type: RecipeOptionType;
  readonly invalid: string;
  readonly valid: string;
  readonly value: RecipeOptionValue;
}[];

const compile = (type: RecipeOptionType, value: RecipeOptionValue) =>
  Result.getOrThrow(
    compileRecipeSource(
      {
        id: "example",
        title: "Example",
        description: "Example",
        version: "1.0.0",
        config: {},
        options: { answer: { type, default: value, prompt: { message: "Answer" } } },
      },
      { sourceKind: "local", packageName: "example", assets: [] },
    ),
  );

test.each([...cases])(
  "retries descriptor-only invalid input before accepting an answer %#",
  async ({ type, invalid, valid, value }) => {
    // Given
    const manifest = compile(type, value);
    const io = createBufferedPromptIO({ inputs: [invalid, valid] });
    // When
    const answers = await collectPrompts({ prompts: manifest.prompts ?? [], io });
    // Then
    expect(answers).toEqual({ answer: value });
    expect(io.stderr().length).toBeGreaterThan(0);
    expect(Result.getOrThrow(validateOptionValues(manifest.snapshot.optionTypes, {}, answers))).toEqual(
      answers,
    );
  },
);

test.each([...cases])(
  "rejects invalid flags with the same descriptor constraints %#",
  async ({ type, invalid, value }) => {
    // Given
    const manifest = compile(type, value);
    // When
    const result = collectPrompts({
      prompts: manifest.prompts ?? [],
      answers: parseAnswerFlags([`answer=${invalid}`]),
      nonInteractive: true,
    });
    // Then
    await expect(result).rejects.toMatchObject({ _tag: "RecipePromptValidationError", promptName: "answer" });
  },
);

test.each([...cases])(
  "accepts the descriptor default and explicit flags identically %#",
  async ({ type, valid, value }) => {
    // Given
    const manifest = compile(type, value);
    const prompts = manifest.prompts ?? [];
    // When
    const answers = await Promise.all([
      collectPrompts({ prompts, nonInteractive: true }),
      collectPrompts({ prompts, answers: parseAnswerFlags([`answer=${valid}`]), nonInteractive: true }),
      collectPrompts({ prompts, io: createBufferedPromptIO({ inputs: [""] }) }),
    ]);
    // Then
    expect(answers).toEqual([{ answer: value }, { answer: value }, { answer: value }]);
  },
);

test("retries through the interactive driver when a descriptor integer rule fails", async () => {
  // Given
  const manifest = compile({ kind: "number", integer: true }, 2);
  const requests: PromptDriverRequest[] = [];
  const inputs = ["1.5", "2"];
  // When
  const answers = await collectPrompts({
    prompts: manifest.prompts ?? [],
    io: createBufferedPromptIO({ inputs: [], isTTY: true }),
    interactiveDriver: {
      readRaw: async (request) => {
        requests.push(request);
        return inputs.shift() ?? "2";
      },
    },
  });
  // Then
  expect(answers).toEqual({ answer: 2 });
  expect(requests).toHaveLength(2);
  expect(requests[1]?.issue).toBeDefined();
});
