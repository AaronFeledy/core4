import { expect, test } from "bun:test";
import { Effect } from "effect";
import { validateRecipeManifestObject } from "../../src/recipes/manifest/service";
import { runPostInit } from "../../src/recipes/post-init/runtime";
import type { ChoicesCommandInput } from "../../src/recipes/prompts/choices-command";

test("accepts a manifest with a canonical translation action", async () => {
  const manifest = {
    id: "test",
    title: "Test",
    description: "Test",
    version: "1.0.0",
    postInit: [{ type: "command", cmd: "app:config:translate" }],
  };
  const result = await Effect.runPromise(Effect.either(validateRecipeManifestObject("test", manifest)));
  expect(result._tag).toBe("Right");
});

for (const guard of [undefined, "true", "{{ true }}", "{{ options.start || true }}"]) {
  test(`rejects a start manifest without an opt-in answer guard: ${String(guard)}`, async () => {
    const manifest = {
      id: "test",
      title: "Test",
      description: "Test",
      version: "1.0.0",
      postInit: [{ type: "command", cmd: "app:start", when: guard }],
    };
    const result = await Effect.runPromise(Effect.either(validateRecipeManifestObject("test", manifest)));
    expect(result._tag).toBe("Left");
  });
}

test("rejects an opt-in prompt that starts services by default", async () => {
  const manifest = {
    id: "test",
    title: "Test",
    description: "Test",
    version: "1.0.0",
    prompts: [{ name: "start", type: "confirm", message: "Start?", default: true }],
    postInit: [{ type: "command", cmd: "app:start", when: "{{ options.start }}" }],
  };
  const result = await Effect.runPromise(Effect.either(validateRecipeManifestObject("test", manifest)));
  expect(result._tag).toBe("Left");
});

test("evaluates a pure condition before a message action", async () => {
  const lines: string[] = [];
  const result = await runPostInit({
    actions: [{ type: "message", text: "visible", when: "{{ options.count > 2 }}" }],
    destination: "/tmp",
    recipeId: "test",
    appName: "test",
    answers: { count: 1 },
    io: {
      out: (line) => {
        lines.push(line);
      },
      err: () => {},
    },
  });
  expect(result.executed).toEqual([{ index: 0, type: "message", skipped: true }]);
  expect(lines).toEqual([]);
});

for (const cmd of ["start", "config:translate", "app:destroy", "meta:setup", "git", " app:start"]) {
  test(`rejects ${cmd} before execution even when runs grants it`, async () => {
    // Given a recipe attempting to extend command authority.
    const calls: ChoicesCommandInput[] = [];
    // When the action reaches the execution boundary.
    const result = runPostInit({
      actions: [{ type: "command", cmd }],
      destination: "/tmp",
      recipeId: "test",
      appName: "test",
      answers: { start: true },
      runs: [cmd],
      commandRunner: async (input) => {
        calls.push(input);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    // Then neither aliases nor recipe-authored grants authorize it.
    await expect(result).rejects.toMatchObject({ _tag: "RecipePostInitError", kind: "invalid-argv" });
    expect(calls).toEqual([]);
  });

  test(`rejects ${cmd} during manifest validation`, async () => {
    // Given a structurally valid manifest with an unauthorized command.
    const manifest = {
      id: "test",
      title: "Test",
      description: "Test",
      version: "1.0.0",
      runs: [cmd],
      postInit: [{ type: "command", cmd }],
    };
    // When decoded before scaffolding.
    const result = await Effect.runPromise(Effect.either(validateRecipeManifestObject("test", manifest)));
    // Then authorization fails before commit.
    expect(result._tag).toBe("Left");
  });
}

for (const start of [undefined, false, "false", true, "true"]) {
  test(`starts only with affirmative answer ${String(start)}`, async () => {
    // Given an explicit opt-in guard and a supplied answer.
    const calls: ChoicesCommandInput[] = [];
    // When post-init evaluates the guard.
    await runPostInit({
      actions: [{ type: "command", cmd: "app:start", when: "{{ options.start }}" }],
      destination: "/tmp",
      recipeId: "test",
      appName: "test",
      answers: { start },
      commandRunner: async (input) => {
        calls.push(input);
        return { exitCode: 0, stdout: "", stderr: "" };
      },
    });
    // Then false strings cannot accidentally start services.
    expect(calls.length).toBe(start === true || start === "true" ? 1 : 0);
  });
}

test("denies unconditional start even with an affirmative answer", async () => {
  // Given an action without an explicit answer guard.
  // When executed directly rather than through manifest validation.
  const result = runPostInit({
    actions: [{ type: "command", cmd: "app:start" }],
    destination: "/tmp",
    recipeId: "test",
    appName: "test",
    answers: { start: true },
  });
  // Then execution fails closed.
  await expect(result).rejects.toMatchObject({ _tag: "RecipePostInitError", kind: "invalid-argv" });
});

test("runs canonical translation independently of host runs grants", async () => {
  // Given an empty host-command allowlist.
  const calls: ChoicesCommandInput[] = [];
  // When a canonical authorized action executes.
  await runPostInit({
    actions: [{ type: "command", cmd: "app:config:translate", args: ["--help"] }],
    destination: "/tmp",
    recipeId: "test",
    appName: "test",
    answers: {},
    runs: [],
    commandRunner: async (input) => {
      calls.push(input);
      return { exitCode: 0, stdout: "", stderr: "" };
    },
  });
  // Then command authority does not pass through the host runner.
  expect(calls).toEqual([{ command: "app:config:translate", args: ["--help"] }]);
});
