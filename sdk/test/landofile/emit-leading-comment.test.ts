import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import * as landofile from "@lando/sdk/landofile";
import { parseLandofile } from "../../src/landofile/parser.ts";

describe("Landofile leading comment blocks", () => {
  const producer = {
    sourceKind: "bundled",
    packageName: "@lando/recipe-drupal",
    recipeId: "drupal",
    manifestVersion: "1.4.0",
    contentDigest: `sha256:${"a".repeat(64)}`,
  } as const;
  const value = {
    name: "my-app",
    recipe: {
      id: "drupal",
      version: "1.4.0",
      producer,
      options: { php: "8.5", webroot: "web" },
    },
    services: {
      appserver: {
        type: "php:{{ recipe.php }}",
        webroot: "{{ recipe.webroot }}",
      },
    },
  };
  const options = { leadingCommentBlock: "recipe-provenance" } as const;

  test("emits the fixed provenance header before the document", () => {
    const output = landofile.emitLandofileYaml(value, options);

    expect(output.split("\n").slice(0, 3)).toEqual([
      "# Recipe knobs. Change a value here to change every `{{ recipe.<option> }}` site below.",
      "# Replace a `{{ recipe.<option> }}` reference with a literal to take that site over.",
      "name: my-app",
    ]);
    expect(output).toContain("php:{{ recipe.php }}");
    expect(output).toContain("{{ recipe.webroot }}");
    expect(output.split("\n").slice(2).join("\n")).toBe(landofile.emitLandofileYaml(value));
  });

  test("round-trips through parseLandofile with the header present", async () => {
    const content = landofile.emitLandofileYaml(value, options);
    const parsed = await Effect.runPromise(parseLandofile({ file: ".lando.yml", content, cwd: "/tmp" }));

    expect(parsed).toEqual(value);
  });

  test("emit without the option is unchanged", () => {
    const plain = landofile.emitLandofileYaml(value);
    const sorted = landofile.emitLandofileYaml(value, { sortKeys: true });

    expect(plain).not.toMatch(/^\s*#/mu);
    expect(sorted).not.toMatch(/^\s*#/mu);
    expect(plain).toContain("php:{{ recipe.php }}");
    expect(plain).toContain("{{ recipe.webroot }}");
    expect(plain).toContain("id: drupal");
  });

  test("the block registry exposes exactly one named block", () => {
    expect(Object.keys(landofile.LANDOFILE_LEADING_COMMENT_BLOCKS)).toEqual(["recipe-provenance"]);
  });
});
