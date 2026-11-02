import { expect, test } from "bun:test";
import { compileRecipeSource } from "@lando/sdk/recipes";
import type { RecipeSourceOption } from "@lando/sdk/schema";
import { Result } from "effect";
import { webrootOption } from "../../../src/recipes/builtin/source-php.ts";
import type { PromptDriverRequest } from "../../../src/recipes/prompts/driver.ts";
import {
  collectPrompts,
  createBufferedPromptIO,
  parseAnswerFlags,
} from "../../../src/recipes/prompts/index.ts";

const promptsFor = (option: RecipeSourceOption, name = "answer") =>
  Result.getOrThrow(
    compileRecipeSource(
      {
        id: "example",
        title: "Example",
        description: "Example",
        version: "1.0.0",
        config: {},
        options: { [name]: option },
      },
      { sourceKind: "local", packageName: "example", assets: [] },
    ),
  ).prompts ?? [];

test("forwards custom validation guidance when the source webroot descriptor rejects an answer", async () => {
  // Given
  const option = webrootOption("web");
  const requests: PromptDriverRequest[] = [];
  const inputs = ["bad path", "web"];
  // When
  const answers = await collectPrompts({
    prompts: promptsFor(option),
    io: createBufferedPromptIO({ inputs: [], isTTY: true }),
    interactiveDriver: {
      readRaw: async (request) => {
        requests.push(request);
        return inputs.shift() ?? "web";
      },
    },
  });
  // Then
  expect(answers).toEqual({ answer: "web" });
  expect(requests).toHaveLength(2);
  expect(requests[1]?.issue).toBe(option.prompt.validationMessage);
});

test.each(["__proto__", "constructor", "toString"])("preserves a source option named %s", async (name) => {
  // Given
  const prompts = promptsFor({ type: { kind: "boolean" }, default: true, prompt: {} }, name);
  // When
  const answers = await Promise.all([
    collectPrompts({ prompts, nonInteractive: true }),
    collectPrompts({ prompts, nonInteractive: true, answers: parseAnswerFlags([`${name}=false`]) }),
    collectPrompts({ prompts, io: createBufferedPromptIO({ inputs: ["false"] }) }),
  ]);
  // Then
  expect(answers).toEqual([{ [name]: true }, { [name]: false }, { [name]: false }]);
});

test.each([
  { type: { kind: "string" }, default: "", prompt: {} },
  { type: { kind: "string", pattern: "^[a-z]+$" }, default: "web", prompt: { type: "path" } },
  { type: { kind: "enum", values: [false, "false"] }, default: "false", prompt: {} },
  { type: { kind: "array", items: { kind: "string" } }, default: ["a,b", "", "a,b"], prompt: {} },
] satisfies RecipeSourceOption[])(
  "preserves typed defaults independent of presentation %#",
  async (option) => {
    // Given
    const prompts = promptsFor(option);
    // When
    const answers = await Promise.all([
      collectPrompts({ prompts, nonInteractive: true }),
      collectPrompts({ prompts, io: createBufferedPromptIO({ inputs: [""] }) }),
      collectPrompts({
        prompts,
        io: createBufferedPromptIO({ inputs: [], isTTY: true }),
        interactiveDriver: { readRaw: async () => "" },
      }),
    ]);
    // Then
    expect(answers).toEqual([
      { answer: option.default },
      { answer: option.default },
      { answer: option.default },
    ]);
  },
);

test("accepts empty strings when the descriptor permits them without a default", async () => {
  // Given
  const prompts = promptsFor({ type: { kind: "string" }, prompt: {} });
  // When
  const answers = await collectPrompts({ prompts, io: createBufferedPromptIO({ inputs: [""] }) });
  // Then
  expect(answers).toEqual({ answer: "" });
});

test("uses the existing manual-entry driver for non-enumerated scalar arrays", async () => {
  // Given
  const prompts = promptsFor({
    type: { kind: "array", items: { kind: "number", integer: true } },
    prompt: {},
  });
  const requests: PromptDriverRequest[] = [];
  const inputs = ["1.5", "2,2"];
  // When
  const answers = await collectPrompts({
    prompts,
    io: createBufferedPromptIO({ inputs: [], isTTY: true }),
    interactiveDriver: {
      readRaw: async (request) => {
        requests.push(request);
        return inputs.shift() ?? "2,2";
      },
    },
  });
  // Then
  expect(answers).toEqual({ answer: [2, 2] });
  expect(requests.map((request) => request.mode)).toEqual(["manual-choice", "manual-choice"]);
});
