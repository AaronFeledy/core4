import { expect, test } from "bun:test";
import { RECIPE_POST_INIT_COMMAND_IDS } from "../../src/cli/allowlists/recipe-post-init";
import { builtInCommandEntries } from "../../src/cli/built-in-command-registry";

test("projects only opted-in canonical command ids from metadata", () => {
  const ids = builtInCommandEntries
    .filter(({ spec }) => spec.recipePostInitAllowed === true)
    .map(({ spec }) => spec.id)
    .sort();
  expect(ids).toEqual(["app:config:translate", "app:start"]);
  const generated: readonly string[] = RECIPE_POST_INIT_COMMAND_IDS;
  expect(generated).toEqual(ids);
});

test("emits an import-free literal allowlist", async () => {
  const source = await Bun.file(
    new URL("../../src/cli/allowlists/recipe-post-init.ts", import.meta.url),
  ).text();
  const literal =
    /^(?:\/\/[^\n]*\n)*export const RECIPE_POST_INIT_COMMAND_IDS = (\[[\s\S]*?\]) as const;\s*$/.exec(
      source,
    )?.[1];
  expect(literal).toBeDefined();
  expect(JSON.parse(literal ?? "null")).toEqual(RECIPE_POST_INIT_COMMAND_IDS);
});

test("documents exactly the generated command authority", async () => {
  const source = await Bun.file(
    new URL("../../../docs/reference/recipe-post-init.mdx", import.meta.url),
  ).text();
  const ids = [...source.matchAll(/^\| `([^`]+)` \|/gm)]
    .flatMap((match) => (match[1] === undefined ? [] : [match[1]]))
    .sort();
  const generated: readonly string[] = RECIPE_POST_INIT_COMMAND_IDS;
  expect(generated).toEqual(ids);
});
