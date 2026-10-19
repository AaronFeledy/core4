import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect, Result } from "effect";

import {
  globalConfigEdit,
  globalConfigSet,
  globalConfigUnset,
  globalConfigValidate,
} from "../../../src/cli/commands/meta/global-config.ts";
import { withEnvVar } from "../../_support/temp-cwd.ts";

let root = "";
const file = (): string => join(root, ".lando.yml");
const recipe = [
  "recipe:",
  "  id: lamp",
  "  version: 0.1.0",
  "  options:",
  "    flag: false",
  "  producer:",
  "    sourceKind: bundled",
  '    packageName: "@lando/recipe-lamp"',
  "    recipeId: lamp",
  "    manifestVersion: 0.1.0",
  `    contentDigest: sha256:${"0".repeat(64)}`,
  "",
].join("\n");
const typedService = 'services:\n  web:\n    primary: "{{ recipe.flag }}"\n';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-global-expressions-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("global config content-layer compilation", () => {
  test.each([".lando.base.yml", ".lando.yml", ".lando.user.yml"])(
    "validates typed whole-value sites with recipe scope from %s",
    async (recipeLayer) => {
      // Given a typed site whose recipe option may live in another layer.
      await writeFile(file(), typedService);
      await writeFile(join(root, recipeLayer), recipeLayer === ".lando.yml" ? recipe + typedService : recipe);
      // When
      const result = await Effect.runPromise(globalConfigValidate(file()));
      // Then
      expect(result).toEqual({ subcommand: "validate", valid: true, issues: [], filePath: file() });
    },
  );

  test("validates typed env sites through the loader compiler", async () => {
    // Given
    await writeFile(file(), `services:\n  web:\n    primary: '{{ eq(env.LANDO_GLOBAL_FLAG, "false") }}'\n`);
    // When
    const result = await withEnvVar("LANDO_GLOBAL_FLAG", "false", () =>
      Effect.runPromise(globalConfigValidate(file())),
    );
    // Then
    expect(result.valid).toBe(true);
  });

  test.each([".lando.yml", ".lando.local.yml"])(
    "rejects a bad boolean in %s with its issue path",
    async (layer) => {
      // Given a genuinely invalid runtime value, including in a sibling layer.
      await writeFile(file(), "name: global\nruntime: 4\n");
      await writeFile(join(root, layer), "services:\n  web:\n    primary: maybe\n");
      // When
      const result = await Effect.runPromise(globalConfigValidate(file()).pipe(Effect.result));
      // Then
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure._tag).toBe("LandofileWriteValidationError");
        if (result.failure._tag === "LandofileWriteValidationError") {
          expect(result.failure.issues.map((issue) => issue.path)).toContainEqual([
            "services",
            "web",
            "primary",
          ]);
        }
      }
    },
  );

  test("set and unset round-trip while retaining authored typed expressions", async () => {
    // Given
    await writeFile(join(root, ".lando.dist.yml"), recipe);
    await writeFile(file(), typedService);
    // When an unrelated value is set and then unset.
    const set = await Effect.runPromise(globalConfigSet({ key: "services.web.type", value: "php" }, file()));
    const unset = await Effect.runPromise(globalConfigUnset({ key: "services.web.type" }, file()));
    // Then the expression remains authoring data, not a baked boolean.
    expect(set).toMatchObject({ subcommand: "set", value: "php", changed: true });
    expect(unset).toMatchObject({ subcommand: "unset", changed: true });
    expect(Bun.YAML.parse(await readFile(file(), "utf8"))).toEqual({
      services: { web: { primary: "{{ recipe.flag }}" } },
    });
  });

  test("set recompiles sibling sites with the edited recipe option", async () => {
    // Given
    await writeFile(join(root, ".lando.base.yml"), typedService);
    await writeFile(file(), recipe);
    const before = await readFile(file(), "utf8");
    // When the option would materialize an invalid boolean in the base layer.
    const result = await Effect.runPromise(
      globalConfigSet({ key: "recipe.options.flag", value: "maybe" }, file()).pipe(Effect.result),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).toBe("LandofileWriteValidationError");
    expect(await readFile(file(), "utf8")).toBe(before);
  });

  test("dry-run validates typed edits without writing", async () => {
    // Given
    await writeFile(join(root, ".lando.dist.yml"), recipe);
    await writeFile(file(), typedService);
    // When
    const result = await Effect.runPromise(
      globalConfigSet({ key: "services.web.primary", value: "{{ recipe.flag }}", dryRun: true }, file()),
    );
    // Then
    expect(result.dryRun).toBe(true);
    expect(await readFile(file(), "utf8")).toBe(typedService);
  });

  test("edit saves typed sites using recipe scope from merged layers", async () => {
    // Given
    await writeFile(join(root, ".lando.dist.yml"), recipe);
    await writeFile(file(), "name: global\n");
    // When
    const result = await Effect.runPromise(
      globalConfigEdit({ editorRunner: async () => ({ kind: "edited", content: typedService }) }, file()),
    );
    // Then
    expect(result).toMatchObject({ subcommand: "edit", changed: true, valid: true });
    expect(await readFile(file(), "utf8")).toBe(typedService);
  });

  test("edit rejects an invalid boolean without replacing the overlay", async () => {
    // Given
    await writeFile(file(), recipe + typedService);
    const before = await readFile(file(), "utf8");
    // When
    const result = await Effect.runPromise(
      globalConfigEdit(
        {
          editorRunner: async () => ({ kind: "edited", content: "services:\n  web:\n    primary: maybe\n" }),
        },
        file(),
      ).pipe(Effect.result),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).toBe("LandofileWriteValidationError");
    expect(await readFile(file(), "utf8")).toBe(before);
  });
});
