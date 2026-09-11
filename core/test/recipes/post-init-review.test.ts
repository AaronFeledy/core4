import { expect, test } from "bun:test";
import { RecipePostInitError } from "@lando/sdk/errors";
import type { RecipePrompt } from "@lando/sdk/schema";
import { postInitAuthorizationIssue } from "../../src/recipes/post-init/authorization";
import { runPostInit } from "../../src/recipes/post-init/runtime";
import { collectPrompts } from "../../src/recipes/prompts/runtime";

for (const when of ["{{ secrets.hidden }}", '{{ options.hidden + "', "{{ options.hidden }}"]) {
  test(`keeps expression errors free of raw answer data: ${when}`, async () => {
    // Given a secret-like answer which must never become diagnostic data.
    const secret = "private-answer-67249";
    // When parsing, scope checking, or boolean evaluation rejects the condition.
    const result = runPostInit({
      actions: [{ type: "message", text: "unused", when }],
      destination: "/tmp",
      recipeId: "review",
      appName: "review",
      answers: { hidden: secret },
    });
    const error: unknown = await result.catch((cause: unknown) => cause);
    // Then only sanitized error metadata crosses the failure boundary.
    expect(error).toBeInstanceOf(RecipePostInitError);
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(JSON.stringify(error)).not.toContain(when);
  });
}

for (const supplied of [false, true]) {
  test(`requires an explicit answer rather than --yes defaults: ${supplied}`, async () => {
    // Given a false-default opt-in prompt and batch-mode default acceptance.
    const prompts: readonly RecipePrompt[] = [
      { name: "start", type: "confirm", message: "Start?", default: false },
    ];
    const answers = await collectPrompts({
      prompts,
      yes: true,
      nonInteractive: true,
      answers: supplied ? { start: "true" } : {},
    });
    let invocations = 0;
    // When the resolved answers reach post-init authorization.
    await runPostInit({
      actions: [{ type: "command", cmd: "app:start", when: "{{ options.start }}" }],
      destination: "/tmp",
      recipeId: "review",
      appName: "review",
      answers,
      commandRunner: async () => {
        invocations += 1;
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    // Then accepting defaults never starts services.
    expect(invocations).toBe(supplied ? 1 : 0);
  });
}

for (const value of [true, "true", "yes", "1", 1]) {
  test(`rejects a recipe-authored affirmative default: ${String(value)}`, () => {
    // Given an affirmative default in any commonly accepted boolean spelling.
    const prompts: readonly RecipePrompt[] = [
      { name: "start", type: "confirm", message: "Start?", default: value },
    ];
    // When semantic validation checks start authority.
    const issue = postInitAuthorizationIssue(
      { type: "command", cmd: "app:start", when: "{{ options.start }}" },
      prompts,
    );
    // Then the recipe cannot manufacture user consent through defaults.
    expect(issue).toBeDefined();
  });
}
