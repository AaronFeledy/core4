import { describe, expect, test } from "bun:test";

import type { LegacyNode } from "../../src/landofile/legacy/contract.ts";
import { resolveLegacyLimits } from "../../src/landofile/legacy/limits.ts";
import { parseLegacyTree } from "../../src/landofile/legacy/parse.ts";

const shape = (node: LegacyNode | null): unknown => {
  if (node === null) return null;
  switch (node.kind) {
    case "scalar":
      return node.text;
    case "alias":
      return `*${node.name}`;
    case "sequence":
      return node.items.map(shape);
    case "mapping":
      return node.entries.map(({ key, value }) => [key.text, shape(value)]);
    default: {
      const exhaustive: never = node;
      return exhaustive;
    }
  }
};

describe("legacy tree — collections", () => {
  const cases: ReadonlyArray<readonly [string, unknown]> = [
    [
      "a: 1\nb:\n  c: 2\n  d:\n    - x\n    - y",
      [
        ["a", "1"],
        [
          "b",
          [
            ["c", "2"],
            ["d", ["x", "y"]],
          ],
        ],
      ],
    ],
    [
      "- key: value\n  sibling: other\n- key:\n    child: yes\n  sibling: end",
      [
        [
          ["key", "value"],
          ["sibling", "other"],
        ],
        [
          ["key", [["child", "yes"]]],
          ["sibling", "end"],
        ],
      ],
    ],
    ["- - one\n  - two\n-\n  - three", [["one", "two"], ["three"]]],
    [
      "key:\nother: # empty\nlast:",
      [
        ["key", ""],
        ["other", ""],
        ["last", ""],
      ],
    ],
    [
      "{a: 1, b: [x, y,],}",
      [
        ["a", "1"],
        ["b", ["x", "y"]],
      ],
    ],
    ["[1, {a: b}, {}, []]", ["1", [["a", "b"]], [], []]],
    [
      "{\n  'a': [\n    x, # note\n    y\n  ],\n  b: {}\n}",
      [
        ["a", ["x", "y"]],
        ["b", []],
      ],
    ],
    [
      '{"a":"b", plain: https://x.test, port: 8080:80}',
      [
        ["a", "b"],
        ["plain", "https://x.test"],
        ["port", "8080:80"],
      ],
    ],
    [
      "cmd: |\n  one\n  two\nnext: yes",
      [
        ["cmd", "one\ntwo\n"],
        ["next", "yes"],
      ],
    ],
    [
      "- web4: |\n    one\n    two\n  sibling: yes\n- |\n  direct\n",
      [
        [
          ["web4", "one\ntwo\n"],
          ["sibling", "yes"],
        ],
        "direct\n",
      ],
    ],
    [
      "{empty: , next: x}",
      [
        ["empty", ""],
        ["next", "x"],
      ],
    ],
    ["[one\n two, 'three\n four']", ["one two", "three four"]],
    ["[&a {one: !load x}, *a]", [[["one", "x"]], "*a"]],
  ];
  for (const [content, expected] of cases) {
    test(`keeps collection structure for ${JSON.stringify(content)}`, () => {
      // Given / When
      const tree = parseLegacyTree(content, "collections.yml", resolveLegacyLimits());
      // Then
      expect(shape(tree.root)).toEqual(expected);
    });
  }

  test("binds references in document order without merging or dereferencing", () => {
    // Given
    const content =
      "x-service: &default-web\n  type: php\npatches:\n  - &PATCHES_APPLY PATCHES_APPLY=0\nPATCHES: *PATCHES_APPLY\nweb:\n  <<: *default-web              # comment\n  type: nginx\n";
    // When
    const tree = parseLegacyTree(content, "references.yml", resolveLegacyLimits());
    // Then
    expect(tree.aliasCount).toBe(2);
    expect([...tree.anchors.keys()]).toEqual(["default-web", "PATCHES_APPLY"]);
    expect(tree.anchors.get("default-web")).toMatchObject({ kind: "mapping", anchor: "default-web" });
    expect(shape(tree.root)).toEqual([
      ["x-service", [["type", "php"]]],
      ["patches", ["PATCHES_APPLY=0"]],
      ["PATCHES", "*PATCHES_APPLY"],
      [
        "web",
        [
          ["<<", "*default-web"],
          ["type", "nginx"],
        ],
      ],
    ]);
  });

  for (const header of ["&a !anything", "!anything &a"]) {
    for (const value of ["value", "[x, y]", "{a: b}", "\n  child: yes", "\n  - yes"]) {
      test(`keeps node properties for ${header} ${JSON.stringify(value)}`, () => {
        // Given / When
        const tree = parseLegacyTree(`key: ${header} ${value}`, "tags.yml", resolveLegacyLimits());
        // Then
        expect(tree.anchors.get("a")).toMatchObject({ tag: "!anything", anchor: "a" });
      });
    }
  }

  test("keeps arbitrary flow-entry and sequence tags as inert text", () => {
    // Given
    const yaml =
      "items: [!load scripts/build.sh, &a !!str 1, *a, !<tag:example.test,2026:x> value]\n/tmp/x: !import rooster\ncommands:\n  - !load scripts/build.sh";
    // When
    const tree = parseLegacyTree(yaml, "tags.yml", resolveLegacyLimits());
    // Then
    expect(tree.anchors.get("a")).toMatchObject({ text: "1", tag: "!!str" });
    expect(tree.aliasCount).toBe(1);
    expect(shape(tree.root)).toEqual([
      ["items", ["scripts/build.sh", "1", "*a", "value"]],
      ["/tmp/x", "rooster"],
      ["commands", ["scripts/build.sh"]],
    ]);
    if (tree.root?.kind !== "mapping") throw new Error("Expected mapping");
    const items = tree.root.entries[0]?.value;
    if (items?.kind !== "sequence") throw new Error("Expected sequence");
    expect(items.items[0]).toMatchObject({ tag: "!load" });
    expect(items.items[3]).toMatchObject({ tag: "!<tag:example.test,2026:x>" });
    expect(tree.root.entries[1]?.value).toMatchObject({ tag: "!import" });
  });

  test("collection spans run from the first child to the last child", () => {
    // Given
    const content = "# lead\na:\n  - first\n  - last # tail\n";
    // When
    const { root } = parseLegacyTree(content, "spans.yml", resolveLegacyLimits());
    // Then
    if (root?.kind !== "mapping") throw new Error("Expected mapping");
    const seq = root.entries[0]?.value;
    expect(content.slice(root.span.start.offset, root.span.end.offset)).toBe("a:\n  - first\n  - last");
    expect(content.slice(seq?.span.start.offset, seq?.span.end.offset)).toBe("first\n  - last");
  });
});
