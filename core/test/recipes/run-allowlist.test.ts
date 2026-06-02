import { RecipeRunNotAllowedError } from "@lando/sdk/errors";

import type { ChoicesCommandRunner } from "../../src/recipes/prompts/choices-command.ts";
import {
  DEFAULT_RUNS_ALLOWLIST,
  createRecipeRunContext,
  defaultRunWarning,
  evaluateRunPermission,
  runNotAllowedError,
} from "../../src/recipes/run-allowlist.ts";

describe("recipe runs allowlist", () => {
  test("explicit runs allow listed command ids", () => {
    expect(evaluateRunPermission(["git", "composer"], "git")).toEqual({ kind: "allowed" });
  });

  test("explicit runs deny command ids outside the allowlist", () => {
    expect(evaluateRunPermission(["git", "composer"], "npm")).toEqual({
      kind: "denied",
      allowlist: ["git", "composer"],
    });
  });

  test("default runs allow built-in command ids", () => {
    expect(evaluateRunPermission(undefined, "npm")).toEqual({ kind: "allowed" });
  });

  test("default runs warn for command ids outside the built-in allowlist", () => {
    expect(evaluateRunPermission(undefined, "pantheon:list-sites")).toEqual({
      kind: "warn",
      allowlist: DEFAULT_RUNS_ALLOWLIST,
    });
  });

  test("runNotAllowedError builds the tagged error payload", () => {
    const error = runNotAllowedError("npm", ["git", "composer"], "fixture");
    expect(error).toBeInstanceOf(RecipeRunNotAllowedError);
    expect(error.commandId).toBe("npm");
    expect(error.allowlist).toEqual(["git", "composer"]);
    expect(error.recipe).toBe("fixture");
    expect(error.message).toContain('"npm"');
    expect(error.remediation).toContain("git, composer");
    expect(error.remediation).toContain("runs:");
  });

  test("defaultRunWarning names the command and default allowlist", () => {
    const warning = defaultRunWarning("pantheon:list-sites", DEFAULT_RUNS_ALLOWLIST);
    expect(warning).toContain('"pantheon:list-sites"');
    expect(warning).toContain("default runs allowlist");
    expect(warning).toContain("git, composer, npm, bun, yarn, pnpm, pip, bundle, make");
  });

  test("createRecipeRunContext denies explicit disallowed commands before invoking the runner", async () => {
    let invoked = 0;
    const runner: ChoicesCommandRunner = async () => {
      invoked += 1;
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const ctx = createRecipeRunContext({ runs: ["git"], runner, recipe: "fixture" });

    let caught: unknown;
    try {
      await ctx.run("npm", ["install"]);
    } catch (cause) {
      caught = cause;
    }

    expect(caught).toBeInstanceOf(RecipeRunNotAllowedError);
    if (caught instanceof RecipeRunNotAllowedError) {
      expect(caught.commandId).toBe("npm");
      expect(caught.allowlist).toEqual(["git"]);
      expect(caught.recipe).toBe("fixture");
    }
    expect(invoked).toBe(0);
  });

  test("createRecipeRunContext warns and proceeds for default commands outside the built-in allowlist", async () => {
    const warnings: string[] = [];
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const runner: ChoicesCommandRunner = async (input) => {
      calls.push(input);
      return { exitCode: 0, stdout: "ok", stderr: "" };
    };
    const ctx = createRecipeRunContext({
      runs: undefined,
      runner,
      onWarn: (message) => warnings.push(message),
    });

    const result = await ctx.run("pantheon:list-sites", ["--format=json"]);

    expect(result).toEqual({ exitCode: 0, stdout: "ok", stderr: "" });
    expect(calls).toEqual([{ command: "pantheon:list-sites", args: ["--format=json"] }]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("pantheon:list-sites");
  });

  test("createRecipeRunContext runs default allowed commands without warning", async () => {
    const warnings: string[] = [];
    const calls: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const runner: ChoicesCommandRunner = async (input) => {
      calls.push(input);
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const ctx = createRecipeRunContext({
      runs: undefined,
      runner,
      onWarn: (message) => warnings.push(message),
    });

    await ctx.run("git", ["init"]);

    expect(calls).toEqual([{ command: "git", args: ["init"] }]);
    expect(warnings).toEqual([]);
  });
});
