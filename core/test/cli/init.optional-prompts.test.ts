import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareInitApp } from "../../src/cli/commands/init-preparation.ts";
import { ownerOnlyFileAccess } from "../_support/private-file-access.ts";

const answerCases: Readonly<Record<string, string>>[] = [{}, { label: "ok" }];

test.each(answerCases)(
  "prepares init with an optional source prompt when answers are %j",
  async (answers) => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-optional-init-"));
    try {
      const recipe = join(root, "optional-example");
      await mkdir(recipe);
      await Bun.write(
        join(recipe, "recipe.yml"),
        `id: optional-example
title: Example
description: Example
version: 1.0.0
options:
  label:
    type:
      kind: optional
      inner:
        kind: string
        pattern: '^[a-z]+$'
    prompt:
      message: Optional label
config:
`,
      );
      // When
      const result = await prepareInitApp({
        cwd: root,
        recipe,
        destination: join(root, "output"),
        name: "optional-example",
        full: false,
        nonInteractive: true,
        answers,
        privateFileAccess: ownerOnlyFileAccess,
      });
      // Then
      expect(result.prepared.status).toBe("ready");
      expect(result.publicAnswers).toEqual({ name: "optional-example", ...answers });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
