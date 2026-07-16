import { describe, expect, test } from "bun:test";

import { Schema } from "effect";

import { RecipeMissingAnswerError } from "@lando/sdk/errors";
import { RecipePrompt } from "@lando/sdk/schema";

import {
  PromptCancelledError,
  type PromptDriver,
  type PromptDriverRequest,
} from "../../../src/recipes/prompts/driver.ts";
import { collectPrompts, createBufferedPromptIO } from "../../../src/recipes/prompts/index.ts";

const prompt = (input: unknown): typeof RecipePrompt.Type => Schema.decodeUnknownSync(RecipePrompt)(input);

interface FakeDriverScript {
  readonly answers: ReadonlyArray<string | Error>;
}

interface FakeDriver extends PromptDriver {
  readonly requests: ReadonlyArray<PromptDriverRequest>;
}

const createFakeDriver = (script: FakeDriverScript): FakeDriver => {
  const requests: PromptDriverRequest[] = [];
  let cursor = 0;
  return {
    requests,
    readRaw: async (request: PromptDriverRequest): Promise<string> => {
      requests.push(request);
      if (cursor >= script.answers.length) {
        throw new Error(`FakeDriver ran out of scripted answers after ${String(cursor)} reads.`);
      }
      const next = script.answers[cursor];
      cursor += 1;
      if (next instanceof Error) throw next;
      return next as string;
    },
  };
};

describe("collectPrompts — interactiveDriver delegation (S1)", () => {
  test("uses the driver and bypasses io.readLine when io is a TTY", async () => {
    const io = createBufferedPromptIO({ inputs: [], isTTY: true });
    const driver = createFakeDriver({ answers: ["my-app"] });
    const answers = await collectPrompts({
      prompts: [prompt({ name: "name", type: "text", message: "App name" })],
      io,
      interactiveDriver: driver,
    });
    expect(answers.name).toBe("my-app");
    expect(driver.requests).toHaveLength(1);
    expect(driver.requests[0]?.prompt.name).toBe("name");
    // The line-based reader must not have been consulted.
    expect(io.stdout()).toBe("");
  });

  test("select prompt receives a 1-based index from the driver", async () => {
    const io = createBufferedPromptIO({ inputs: [], isTTY: true });
    const driver = createFakeDriver({ answers: ["2"] });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "size",
          type: "select",
          message: "Pick",
          choices: ["small", "medium", "large"],
        }),
      ],
      io,
      interactiveDriver: driver,
    });
    expect(answers.size).toBe("medium");
    expect(driver.requests[0]?.choices).toHaveLength(3);
  });

  test("multiselect maps comma-separated 1-based indices from the driver to selected values", async () => {
    const io = createBufferedPromptIO({ inputs: [], isTTY: true });
    const driver = createFakeDriver({ answers: ["1,3"] });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "addons",
          type: "multiselect",
          message: "Pick addons",
          choices: ["redis", "search", "queue"],
        }),
      ],
      io,
      interactiveDriver: driver,
    });
    expect(answers.addons).toEqual(["redis", "queue"]);
    expect(driver.requests).toHaveLength(1);
  });

  test("multiselect maps an empty driver answer to an empty array when bounds allow", async () => {
    const io = createBufferedPromptIO({ inputs: [], isTTY: true });
    const driver = createFakeDriver({ answers: [""] });
    const answers = await collectPrompts({
      prompts: [
        prompt({
          name: "addons",
          type: "multiselect",
          message: "Pick addons",
          choices: ["redis", "search"],
        }),
      ],
      io,
      interactiveDriver: driver,
    });
    expect(answers.addons).toEqual([]);
    expect(driver.requests).toHaveLength(1);
  });
});

describe("collectPrompts — inline validation re-prompt (S2)", () => {
  test("re-invokes the driver with the validation issue and returns the coerced value", async () => {
    const io = createBufferedPromptIO({ inputs: [], isTTY: true });
    const driver = createFakeDriver({ answers: ["abc", "5"] });
    const answers = await collectPrompts({
      prompts: [prompt({ name: "port", type: "number", message: "Port" })],
      io,
      interactiveDriver: driver,
    });
    expect(answers.port).toBe(5);
    expect(driver.requests).toHaveLength(2);
    expect(driver.requests[0]?.issue).toBeUndefined();
    expect(driver.requests[1]?.issue).toContain("not a number");
  });
});

describe("collectPrompts — driver bypass preserves deterministic behavior (S3)", () => {
  test("non-TTY io ignores the driver and uses the line-based reader", async () => {
    const io = createBufferedPromptIO({ inputs: ["typed-app"], isTTY: false });
    const driver = createFakeDriver({ answers: ["driver-app"] });
    const answers = await collectPrompts({
      prompts: [prompt({ name: "name", type: "text", message: "App name" })],
      io,
      interactiveDriver: driver,
    });
    expect(answers.name).toBe("typed-app");
    expect(driver.requests).toHaveLength(0);
    expect(io.stdout()).toContain("App name");
  });

  test("nonInteractive ignores the driver and raises the tagged missing-answer error", async () => {
    const io = createBufferedPromptIO({ inputs: [], isTTY: true });
    const driver = createFakeDriver({ answers: ["driver-app"] });
    const promise = collectPrompts({
      prompts: [prompt({ name: "name", type: "text", message: "App name" })],
      io,
      interactiveDriver: driver,
      nonInteractive: true,
    });
    await expect(promise).rejects.toBeInstanceOf(RecipeMissingAnswerError);
    expect(driver.requests).toHaveLength(0);
  });

  test("--yes ignores the driver and uses the recipe default", async () => {
    const io = createBufferedPromptIO({ inputs: [], isTTY: true });
    const driver = createFakeDriver({ answers: ["driver-app"] });
    const answers = await collectPrompts({
      prompts: [prompt({ name: "name", type: "text", message: "App name", default: "default-app" })],
      io,
      interactiveDriver: driver,
      yes: true,
    });
    expect(answers.name).toBe("default-app");
    expect(driver.requests).toHaveLength(0);
  });
});

describe("collectPrompts — cancellation propagates (S4)", () => {
  test("PromptCancelledError from the driver propagates and is not swallowed to a fallback", async () => {
    const io = createBufferedPromptIO({ inputs: ["should-not-be-read"], isTTY: true });
    const driver = createFakeDriver({ answers: [new PromptCancelledError()] });
    const promise = collectPrompts({
      prompts: [prompt({ name: "name", type: "text", message: "App name" })],
      io,
      interactiveDriver: driver,
    });
    await expect(promise).rejects.toBeInstanceOf(PromptCancelledError);
  });
});
