import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { detectLandofileTags, parseLandofile } from "@lando/sdk/landofile";

const parse = (content: string) =>
  Effect.runPromise(parseLandofile({ file: ".lando.local.yml", content, cwd: "/tmp" })) as Promise<
    Record<string, unknown>
  >;

describe("Landofile block scalars", () => {
  test("parses yaml-stringified folded commands in tooling.cmds sequences", async () => {
    const parsed = await parse(
      [
        "tooling:",
        "  drush:",
        "    cmds:",
        "      - >-",
        "        if test -f /app/vendor/bin/drush; then",
        '        exec /app/vendor/bin/drush "$@"',
        "        fi",
        "name: cms",
        "",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      tooling: {
        drush: {
          cmds: ['if test -f /app/vendor/bin/drush; then exec /app/vendor/bin/drush "$@" fi'],
        },
      },
      name: "cms",
    });
  });

  test("honors literal, folded, clip, strip, and keep chomping in mappings and sequences", async () => {
    const parsed = await parse(
      [
        "literal: |-",
        "  first",
        "  second",
        "folded: >",
        "  first",
        "  second",
        "kept: |+",
        "  first",
        "",
        "entries:",
        "  - cmd: >-",
        "      echo one",
        "      echo two",
        "    name: drush",
        "  - |-",
        "    # this is command text",
        "    echo done",
        "",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      literal: "first\nsecond",
      folded: "first second\n",
      kept: "first\n\n",
      entries: [{ cmd: "echo one echo two", name: "drush" }, "# this is command text\necho done"],
    });
  });
  test("empty blocks clip to empty while keep preserves blank lines", async () => {
    const parsed = await parse(
      [
        "emptyLiteral: |",
        "",
        "emptyFolded: >-",
        "",
        "keptLiteral: |+",
        "",
        "",
        "keptFolded: >+",
        "",
        "next: value",
        "",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      emptyLiteral: "",
      emptyFolded: "",
      keptLiteral: "\n\n",
      keptFolded: "\n",
      next: "value",
    });
  });

  test("folding preserves blank separators around more-indented lines", async () => {
    const parsed = await parse(
      ["first: >", "  a", "    b", "", "  c", "second: >", "  a", "", "    b", "  c", ""].join("\n"),
    );
    expect(parsed).toEqual({
      first: "a\n  b\n\nc\n",
      second: "a\n\n  b\nc\n",
    });
  });

  test("tag detection ignores directive-looking text inside block scalars", () => {
    const content = ["cmds:", "  - |-", "    - !reset", "    line: !override", "actual: !reset", ""].join(
      "\n",
    );
    expect(detectLandofileTags({ file: ".lando.local.yml", content })).toEqual([
      { tag: "!reset", line: 5, column: 9 },
    ]);
  });
});
