import { expect, test } from "bun:test";
import { compileRecipeSource, validateOptionValues } from "@lando/sdk/recipes";
import type { RecipeOptionType, RecipeOptionValue, RecipeSourceOption } from "@lando/sdk/schema";
import { Result } from "effect";
import { initOptionPrompts, typedInitAnswers } from "../../../src/cli/commands/init-option-answers.ts";
import { PromptCancelledError, type PromptDriverRequest } from "../../../src/recipes/prompts/driver.ts";
import { collectPrompts, createBufferedPromptIO } from "../../../src/recipes/prompts/index.ts";

const manifestFor = (option: RecipeSourceOption) =>
  Result.getOrThrow(
    compileRecipeSource(
      {
        id: "optional-example",
        title: "Example",
        description: "Example",
        version: "1.0.0",
        config: {},
        options: { label: option },
      },
      { sourceKind: "local", packageName: "example", assets: [] },
    ),
  );

const cases = [
  { inner: { kind: "string", minLength: 2, pattern: "^[a-z]+$" }, raw: "ok", value: "ok" },
  { inner: { kind: "number", integer: true }, raw: "2", value: 2 },
  { inner: { kind: "boolean" }, raw: "false", value: false },
  { inner: { kind: "enum", values: [false, "fast"] }, raw: "false", value: false },
  { inner: { kind: "array", items: { kind: "string" }, minItems: 1 }, raw: "a,b", value: ["a", "b"] },
  {
    inner: { kind: "array", items: { kind: "enum", values: ["a", "b"] }, minItems: 1 },
    raw: "a,b",
    value: ["a", "b"],
  },
] as const satisfies readonly {
  readonly inner: Exclude<RecipeOptionType, { readonly kind: "optional" }>;
  readonly raw: string;
  readonly value: RecipeOptionValue;
}[];

test.each([...cases])("omits an unanswered optional source option noninteractively %#", async ({ inner }) => {
  // Given
  const manifest = manifestFor({ type: { kind: "optional", inner }, prompt: { message: "Optional label" } });
  const prompts = initOptionPrompts(manifest);
  // When
  const answers = await collectPrompts({ prompts, nonInteractive: true });
  // Then
  expect(prompts).toHaveLength(1);
  expect(answers).toEqual({});
  expect(Object.hasOwn(answers, "label")).toBe(false);
  expect(
    Result.getOrThrow(
      validateOptionValues(
        manifest.snapshot.optionTypes,
        {},
        typedInitAnswers(manifest.snapshot.optionTypes, answers),
      ),
    ),
  ).toEqual({});
});

test.each([...cases])(
  "validates an explicitly supplied optional source value %#",
  async ({ inner, raw, value }) => {
    // Given
    const prompts = initOptionPrompts(manifestFor({ type: { kind: "optional", inner }, prompt: {} }));
    // When
    const answers = await collectPrompts({ prompts, answers: { label: raw }, nonInteractive: true });
    // Then
    expect(answers).toEqual({ label: value });
  },
);

test.each([...cases])(
  "omits optional input on interactive blank instead of coercing a value %#",
  async ({ inner }) => {
    // Given
    const prompts = initOptionPrompts(manifestFor({ type: { kind: "optional", inner }, prompt: {} }));
    const io = createBufferedPromptIO({ inputs: [""] });
    // When
    const answers = await collectPrompts({ prompts, io });
    // Then
    expect(answers).toEqual({});
    expect(Object.hasOwn(answers, "label")).toBe(false);
  },
);

test.each([
  { type: { kind: "optional", inner: { kind: "string" } }, default: "", prompt: {} },
  { type: { kind: "optional", inner: { kind: "boolean" } }, default: false, prompt: {} },
  {
    type: { kind: "optional", inner: { kind: "array", items: { kind: "string" } } },
    default: [],
    prompt: {},
  },
] satisfies RecipeSourceOption[])(
  "accepts an optional descriptor default noninteractively %#",
  async (option) => {
    // Given
    const prompts = initOptionPrompts(manifestFor(option));
    // When
    const answers = await collectPrompts({ prompts, nonInteractive: true });
    // Then
    expect(answers).toEqual({ label: option.default });
  },
);

test.each([
  { type: { kind: "optional", inner: { kind: "string" } }, default: "", prompt: {} },
  { type: { kind: "optional", inner: { kind: "boolean" } }, default: false, prompt: {} },
  {
    type: { kind: "optional", inner: { kind: "array", items: { kind: "string" } } },
    default: [],
    prompt: {},
  },
] satisfies RecipeSourceOption[])(
  "uses the optional default rather than omission on interactive blank %#",
  async (option) => {
    // Given
    const prompts = initOptionPrompts(manifestFor(option));
    // When
    const answers = await collectPrompts({ prompts, io: createBufferedPromptIO({ inputs: [""] }) });
    // Then
    expect(answers).toEqual({ label: option.default });
  },
);

test("retries invalid optional interactive input before allowing omission", async () => {
  // Given
  const prompts = initOptionPrompts(
    manifestFor({ type: { kind: "optional", inner: { kind: "number", integer: true } }, prompt: {} }),
  );
  const io = createBufferedPromptIO({ inputs: ["1.5", ""] });
  // When
  const answers = await collectPrompts({ prompts, io });
  // Then
  expect(answers).toEqual({});
  expect(io.stderr().length).toBeGreaterThan(0);
});

test("rejects invalid explicit optional input rather than treating it as omission", async () => {
  // Given
  const prompts = initOptionPrompts(
    manifestFor({ type: { kind: "optional", inner: { kind: "number", integer: true } }, prompt: {} }),
  );
  // When
  const result = collectPrompts({ prompts, nonInteractive: true, answers: { label: "1.5" } });
  // Then
  await expect(result).rejects.toMatchObject({ _tag: "RecipePromptValidationError", promptName: "label" });
});

test("preserves explicit empty strings while optional interactive blanks mean omission", async () => {
  // Given
  const prompts = initOptionPrompts(
    manifestFor({ type: { kind: "optional", inner: { kind: "string" } }, prompt: {} }),
  );
  // When
  const answers = await collectPrompts({ prompts, nonInteractive: true, answers: { label: "" } });
  // Then
  expect(answers).toEqual({ label: "" });
});

test("propagates blank omission from a TTY driver after invalid input", async () => {
  // Given
  const prompts = initOptionPrompts(
    manifestFor({ type: { kind: "optional", inner: { kind: "string", pattern: "^[a-z]+$" } }, prompt: {} }),
  );
  const requests: PromptDriverRequest[] = [];
  const inputs = ["BAD", ""];
  const driver = {
    readRaw: async (request: PromptDriverRequest) => {
      requests.push(request);
      const raw = inputs.shift();
      if (raw === undefined) throw new PromptCancelledError();
      return raw;
    },
  };
  // When
  const answers = await collectPrompts({
    prompts,
    io: createBufferedPromptIO({ inputs: [], isTTY: true }),
    interactiveDriver: driver,
  });
  // Then
  expect(answers).toEqual({});
  expect(requests).toHaveLength(2);
  expect(requests[1]?.issue).toBeDefined();
});

test("retains required missing-answer failures", async () => {
  // Given
  const prompts = initOptionPrompts(manifestFor({ type: { kind: "string", minLength: 1 }, prompt: {} }));
  // When
  const result = collectPrompts({ prompts, nonInteractive: true });
  // Then
  await expect(result).rejects.toMatchObject({ _tag: "RecipeMissingAnswerError", promptName: "label" });
});

test("omits an optional option with --yes without reading input", async () => {
  // Given
  const prompts = initOptionPrompts(
    manifestFor({ type: { kind: "optional", inner: { kind: "string" } }, prompt: {} }),
  );
  // When
  const answers = await collectPrompts({ prompts, yes: true, io: createBufferedPromptIO({ inputs: [] }) });
  // Then
  expect(answers).toEqual({});
});

test("distinguishes a required empty array from an omitted optional array", async () => {
  // Given
  const prompts = initOptionPrompts(
    manifestFor({ type: { kind: "array", items: { kind: "string" } }, prompt: {} }),
  );
  // When
  const answers = await collectPrompts({ prompts, io: createBufferedPromptIO({ inputs: [""] }) });
  // Then
  expect(answers).toEqual({ label: [] });
});

test("omits optional editor input without falling back to a second prompt", async () => {
  // Given
  const prompts = initOptionPrompts(
    manifestFor({
      type: { kind: "optional", inner: { kind: "string", minLength: 1 } },
      prompt: { type: "editor" },
    }),
  );
  // When
  const answers = await collectPrompts({
    prompts,
    io: createBufferedPromptIO({ inputs: [], isTTY: true }),
    editorRunner: async () => ({ kind: "edited", content: "" }),
  });
  // Then
  expect(answers).toEqual({});
});

test.each([{ kind: "boolean" }, { kind: "enum", values: [false, "fast"] }] as const)(
  "allows TTY omission when a %j widget always selects a value",
  async (inner) => {
    // Given
    const prompts = initOptionPrompts(manifestFor({ type: { kind: "optional", inner }, prompt: {} }));
    const io = createBufferedPromptIO({ inputs: [""], isTTY: true });
    // When
    const answers = await collectPrompts({
      prompts,
      io,
      interactiveDriver: { readRaw: async () => "1" },
    });
    // Then
    expect(answers).toEqual({});
  },
);
