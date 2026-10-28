import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecipePromptValidationError } from "@lando/sdk/errors";
import { prepareInitApp } from "../../src/cli/commands/init-preparation.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";

const marker = "RAW_SECRET_CANARY_d894";
const writeRecipe = async (root: string, disposition: "init-only" | "secret-store") => {
  const recipe = join(root, "secret-example");
  await mkdir(recipe);
  await Bun.write(
    join(recipe, "recipe.yml"),
    `id: secret-example
title: Secret example
description: Secret example
version: 1.0.0
options:
  token:
    type:
      kind: secret
    disposition:
      kind: ${disposition}
${disposition === "init-only" ? "      sink:\n        kind: stdin" : "      field: services.web.environment.TOKEN"}
config:
  services:
    web:
      image: alpine:3.21
${disposition === "init-only" ? "postInit:\n  - type: bun\n    verb: install\n    stdin:\n      prompt: token\n" : ""}`,
  );
  return recipe;
};
const cases = [
  { disposition: "init-only", value: marker },
  { disposition: "init-only", value: "${secret:EXISTING}" },
  { disposition: "secret-store", value: marker },
  { disposition: "secret-store", value: "prefix ${secret:EXISTING}" },
] as const;

for (const transport of ["inline", "file"] as const) {
  test.each([...cases])(
    `rejects $disposition secret input from ${transport} before prompting ($value)`,
    async ({ disposition, value }) => {
      // Given
      const root = await mkdtemp(join(tmpdir(), "lando-secret-answers-"));
      let promptCalls = 0;
      try {
        const recipe = await writeRecipe(root, disposition);
        const answersFile = join(root, "answers.json");
        if (transport === "file") await Bun.write(answersFile, JSON.stringify({ token: value }));
        // When
        const result = prepareInitApp({
          cwd: root,
          recipe,
          name: "secret-example",
          destination: join(root, "output"),
          full: false,
          ...(transport === "file" ? { answersFile } : { answers: { token: value } }),
          privateFileAccess: ownerOnlyFileAccess,
          interaction: {
            promptAll: async () => {
              promptCalls += 1;
              return { name: "secret-example", token: value };
            },
            confirm: async () => true,
            select: async () => {
              throw new Error("Unexpected recipe selection");
            },
          },
        });
        // Then
        const error = await result.then(
          () => undefined,
          (error: unknown) => error,
        );
        expect(error).toBeInstanceOf(RecipePromptValidationError);
        expect(error).toMatchObject({
          _tag: "RecipePromptValidationError",
          promptName: "token",
          promptType: "secret",
        });
        expect(JSON.stringify(error)).not.toContain(value);
        expect(promptCalls).toBe(0);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

test.each(["inline", "file", "interactive"])(
  "preserves approved secret input via %s without exporting secret answers",
  async (transport) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-approved-secret-"));
    const value = transport === "interactive" ? marker : "${secret:EXISTING}";
    try {
      const recipe = await writeRecipe(root, transport === "interactive" ? "init-only" : "secret-store");
      const answersFile = join(root, "answers.json");
      if (transport === "file") await Bun.write(answersFile, JSON.stringify({ token: value }));
      // When
      const result = await prepareInitApp({
        cwd: root,
        recipe,
        name: "secret-example",
        destination: join(root, "output"),
        full: false,
        ...(transport === "file"
          ? { answersFile }
          : transport === "inline"
            ? { answers: { token: value } }
            : {}),
        privateFileAccess: ownerOnlyFileAccess,
        interaction: {
          promptAll: async (prompts, options) => {
            expect(prompts).toContainEqual(expect.objectContaining({ name: "token", type: "secret" }));
            expect(options?.answers?.token).toBe(transport === "interactive" ? undefined : value);
            return { name: "secret-example", token: value };
          },
          confirm: async () => true,
          select: async () => {
            throw new Error("Unexpected recipe selection");
          },
        },
      });
      // Then
      expect(result.prepared.status).toBe("ready");
      expect(result.publicAnswers).toEqual({ name: "secret-example" });
      expect(result.prepared.preview.landofile).not.toContain(marker);
      if (transport !== "interactive") expect(result.prepared.preview.landofile).toContain(value);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
