import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  type LandofileTagOccurrence,
  detectLandofileTags,
  override,
  parseLandofile,
  reset,
} from "@lando/sdk/landofile";

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

  test.each(
    ["|", "|-", "|+", ">", ">-", ">+"].flatMap((indicator) =>
      ["&text", "!override", "&text !override", "!reset"].flatMap((prefix) =>
        ["mapping", "first list member", "later list member"].map((context) => ({
          indicator,
          prefix,
          context,
        })),
      ),
    ),
  )("tag detection skips $prefix $indicator bodies in $context", async ({ indicator, prefix, context }) => {
    const list = context !== "mapping";
    const header = list ? (context === "first list member" ? "  - text:" : "    text:") : "literal:";
    const indent = list ? "      " : "  ";
    const lines = [
      ...(list ? ["items:", ...(context === "later list member" ? ["  - name: entry"] : [])] : []),
      `${header} ${prefix} ${indicator} # header comment`,
      `${indent}[!reset]`,
      `${indent}line: !override`,
      `${indent}# literal comment`,
      "",
      `${indent}tail`,
      "",
      `${list ? "    " : ""}actual: !reset`,
      "",
    ];
    const content = lines.join("\n");
    const headerLine = list ? (context === "first list member" ? 2 : 3) : 1;
    const headerTag = prefix.includes("!override")
      ? "!override"
      : prefix.includes("!reset")
        ? "!reset"
        : undefined;
    const expected: LandofileTagOccurrence[] = [];
    if (headerTag !== undefined) {
      expected.push({
        tag: headerTag,
        line: headerLine,
        column: (lines[headerLine - 1]?.indexOf(headerTag) ?? -1) + 1,
      });
    }
    expected.push({ tag: "!reset", line: lines.length - 1, column: list ? 13 : 9 });
    expect(detectLandofileTags({ file: ".lando.local.yml", content })).toEqual(expected);
    const body = indicator.startsWith("|")
      ? "[!reset]\nline: !override\n# literal comment\n\ntail"
      : "[!reset] line: !override # literal comment\ntail";
    const value = body + (indicator.endsWith("-") ? "" : indicator.endsWith("+") ? "\n\n" : "\n");
    const text = headerTag === "!override" ? override(value) : headerTag === "!reset" ? reset() : value;
    expect(await parse(content)).toEqual(
      list
        ? {
            items: [{ ...(context === "later list member" ? { name: "entry" } : {}), text, actual: reset() }],
          }
        : { literal: text, actual: reset() },
    );
  });

  test("does not interpret quoted block headers as scalar blocks", async () => {
    const content = 'literal: "|"\nactual: !reset\n';
    expect(detectLandofileTags({ file: ".lando.local.yml", content })).toEqual([
      { tag: "!reset", line: 2, column: 9 },
    ]);
    expect(await parse(content)).toEqual({ literal: "|", actual: reset() });
  });

  test.each(["!unknown |", "!override !reset |", "!override &text |"])(
    "keeps unsupported prefix order or tag %s rejected",
    async (prefix) => {
      const content = `literal: ${prefix}\n  [!reset]\n`;
      const result = await Effect.runPromise(
        Effect.result(parseLandofile({ file: ".lando.local.yml", content, cwd: "/tmp" })),
      );
      expect(result._tag).toBe("Failure");
    },
  );
});
