import { describe, expect, test } from "bun:test";

import { RecipeChoicesError, RecipeMissingAnswerError } from "@lando/sdk/errors";
import type { RecipePrompt } from "@lando/sdk/schema";

import type { ChoicesCommandRunner } from "../../../src/recipes/prompts/choices-command.ts";
import { createBufferedPromptIO } from "../../../src/recipes/prompts/io.ts";
import { collectPrompts } from "../../../src/recipes/prompts/runtime.ts";

const dynamicSelect: RecipePrompt = {
  name: "phpVersion",
  type: "select",
  message: "PHP version?",
  choicesFrom: { command: "services:list", args: ["--type=php"], parse: "lines" },
};

const fixedRunner =
  (result: { exitCode: number; stdout: string; stderr?: string }): ChoicesCommandRunner =>
  async () => ({ exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr ?? "" });

describe("collectPrompts — dynamic choicesFrom", () => {
  test("interactive: fetched choices are presented and resolved by index", async () => {
    const io = createBufferedPromptIO({ inputs: ["2"], isTTY: true });
    const runner = fixedRunner({ exitCode: 0, stdout: "8.2\n8.3\n8.4\n" });
    const answers = await collectPrompts({ prompts: [dynamicSelect], io, choicesRunner: runner });
    expect(answers.phpVersion).toBe("8.3");
    expect(io.stdout()).toContain("8.3");
  });

  test("interactive: resolves by literal value", async () => {
    const io = createBufferedPromptIO({ inputs: ["8.4"], isTTY: true });
    const runner = fixedRunner({ exitCode: 0, stdout: "8.2\n8.3\n8.4\n" });
    const answers = await collectPrompts({ prompts: [dynamicSelect], io, choicesRunner: runner });
    expect(answers.phpVersion).toBe("8.4");
  });

  test("json parse mode resolves choices", async () => {
    const prompt: RecipePrompt = {
      ...dynamicSelect,
      choicesFrom: { command: "x", parse: "json" },
    };
    const io = createBufferedPromptIO({ inputs: ["1"], isTTY: true });
    const runner = fixedRunner({ exitCode: 0, stdout: '["alpha","beta"]' });
    const answers = await collectPrompts({ prompts: [prompt], io, choicesRunner: runner });
    expect(answers.phpVersion).toBe("alpha");
  });

  test("command exit != 0 falls back to a manual free-text prompt", async () => {
    const io = createBufferedPromptIO({ inputs: ["7.4"], isTTY: true });
    const runner = fixedRunner({ exitCode: 1, stdout: "", stderr: "boom" });
    const answers = await collectPrompts({ prompts: [dynamicSelect], io, choicesRunner: runner });
    expect(answers.phpVersion).toBe("7.4");
    expect(io.stderr()).toContain("Could not load choices");
  });

  test("unparseable output falls back to a manual free-text prompt", async () => {
    const prompt: RecipePrompt = {
      ...dynamicSelect,
      choicesFrom: { command: "x", parse: "json" },
    };
    const io = createBufferedPromptIO({ inputs: ["manual"], isTTY: true });
    const runner = fixedRunner({ exitCode: 0, stdout: "not json" });
    const answers = await collectPrompts({ prompts: [prompt], io, choicesRunner: runner });
    expect(answers.phpVersion).toBe("manual");
    expect(io.stderr()).toContain("Could not load choices");
  });

  test("supplied --answer is accepted without running the command", async () => {
    let invoked = 0;
    const runner: ChoicesCommandRunner = async () => {
      invoked += 1;
      return { exitCode: 0, stdout: "8.2\n", stderr: "" };
    };
    const answers = await collectPrompts({
      prompts: [dynamicSelect],
      answers: { phpVersion: "8.1" },
      nonInteractive: true,
      choicesRunner: runner,
    });
    expect(answers.phpVersion).toBe("8.1");
    expect(invoked).toBe(0);
  });

  test("non-interactive command failure without answer throws RecipeChoicesError", async () => {
    const runner = fixedRunner({ exitCode: 2, stdout: "" });
    let caught: unknown;
    try {
      await collectPrompts({ prompts: [dynamicSelect], nonInteractive: true, choicesRunner: runner });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(RecipeChoicesError);
    if (caught instanceof RecipeChoicesError) {
      expect(caught.promptName).toBe("phpVersion");
      expect(caught.command).toBe("services:list");
      expect(caught.kind).toBe("command-failed");
      expect(caught.exitCode).toBe(2);
      expect(caught.remediation).toContain("--answer");
    }
  });

  test("non-interactive command failure with a default uses the default", async () => {
    const prompt: RecipePrompt = { ...dynamicSelect, default: "8.2" };
    const runner = fixedRunner({ exitCode: 1, stdout: "" });
    const answers = await collectPrompts({ prompts: [prompt], nonInteractive: true, choicesRunner: runner });
    expect(answers.phpVersion).toBe("8.2");
  });

  test("multiselect dynamic choices resolve a comma list", async () => {
    const prompt: RecipePrompt = {
      name: "exts",
      type: "multiselect",
      message: "Extensions?",
      choicesFrom: { command: "x", parse: "lines" },
    };
    const io = createBufferedPromptIO({ inputs: ["gd,redis"], isTTY: true });
    const runner = fixedRunner({ exitCode: 0, stdout: "gd\nredis\nbcmath\n" });
    const answers = await collectPrompts({ prompts: [prompt], io, choicesRunner: runner });
    expect(answers.exts).toEqual(["gd", "redis"]);
  });

  test("interactive: a runner that throws falls back to a manual free-text prompt", async () => {
    const io = createBufferedPromptIO({ inputs: ["7.4"], isTTY: true });
    const throwingRunner: ChoicesCommandRunner = async () => {
      throw new Error("spawn failed");
    };
    const answers = await collectPrompts({ prompts: [dynamicSelect], io, choicesRunner: throwingRunner });
    expect(answers.phpVersion).toBe("7.4");
    expect(io.stderr()).toContain("Could not load choices");
  });

  test("non-interactive empty command output throws RecipeChoicesError with kind empty", async () => {
    const prompt: RecipePrompt = { ...dynamicSelect, choicesFrom: { command: "x", parse: "json" } };
    const runner = fixedRunner({ exitCode: 0, stdout: "[]" });
    let caught: unknown;
    try {
      await collectPrompts({ prompts: [prompt], nonInteractive: true, choicesRunner: runner });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(RecipeChoicesError);
    if (caught instanceof RecipeChoicesError) expect(caught.kind).toBe("empty");
  });

  test("non-interactive command success without answer or default throws RecipeMissingAnswerError", async () => {
    const runner = fixedRunner({ exitCode: 0, stdout: "8.2\n8.3\n" });
    const promise = collectPrompts({ prompts: [dynamicSelect], nonInteractive: true, choicesRunner: runner });
    await expect(promise).rejects.toBeInstanceOf(RecipeMissingAnswerError);
  });

  test("--yes never blocks on a manual fallback prompt when the command fails", async () => {
    // A TTY io is present (interactive=true) but --yes means non-interactive
    // intent: a choicesFrom failure must NOT drop into io.readLine() and hang.
    const io = createBufferedPromptIO({ inputs: ["should-not-be-read"], isTTY: true });
    const runner = fixedRunner({ exitCode: 1, stdout: "", stderr: "boom" });
    let caught: unknown;
    try {
      await collectPrompts({ prompts: [dynamicSelect], yes: true, io, choicesRunner: runner });
    } catch (cause) {
      caught = cause;
    }
    expect(caught).toBeInstanceOf(RecipeChoicesError);
    if (caught instanceof RecipeChoicesError) expect(caught.kind).toBe("command-failed");
  });

  test("--yes with a default uses the default on command failure instead of prompting", async () => {
    const prompt: RecipePrompt = { ...dynamicSelect, default: "8.2" };
    const io = createBufferedPromptIO({ inputs: ["should-not-be-read"], isTTY: true });
    const runner = fixedRunner({ exitCode: 1, stdout: "" });
    const answers = await collectPrompts({ prompts: [prompt], yes: true, io, choicesRunner: runner });
    expect(answers.phpVersion).toBe("8.2");
  });
});
