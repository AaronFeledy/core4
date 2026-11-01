import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { LandofileParseError } from "@lando/sdk/errors";
import { parseLegacyLandofile } from "@lando/sdk/landofile";

const parse = (content: string) =>
  Effect.runSync(parseLegacyLandofile({ mode: "legacy", file: "indentationless.yml", content }));

describe("legacy indentationless block sequences", () => {
  const cases = [
    {
      name: "nested volumes",
      content:
        "services:\n  appserver:\n    volumes:\n    - ./:/site\n    - ./conf:/etc/conf\n    type: php\n",
      indented:
        "services:\n  appserver:\n    volumes:\n      - ./:/site\n      - ./conf:/etc/conf\n    type: php\n",
      value: { services: { appserver: { volumes: ["./:/site", "./conf:/etc/conf"], type: "php" } } },
    },
    {
      name: "top-level sequence of mappings",
      content: "volumes:\n- source: x\n  target: y\n- source: z\n  target: w\nname: demo\n",
      indented: "volumes:\n  - source: x\n    target: y\n  - source: z\n    target: w\nname: demo\n",
      value: {
        volumes: [
          { source: "x", target: "y" },
          { source: "z", target: "w" },
        ],
        name: "demo",
      },
    },
    {
      name: "sequences inside compact mappings",
      content: "- volumes:\n  - source: x\n    target: y\n  type: php\n- volumes:\n  - z\n",
      indented: "- volumes:\n    - source: x\n      target: y\n  type: php\n- volumes:\n    - z\n",
      value: [{ volumes: [{ source: "x", target: "y" }], type: "php" }, { volumes: ["z"] }],
    },
    {
      name: "recursive indentationless mapping values",
      content:
        "items:\n- mounts:\n  - source: x\n    targets:\n    - y\n    - z\n  enabled: true\nnext: done\n",
      indented:
        "items:\n  - mounts:\n      - source: x\n        targets:\n          - y\n          - z\n    enabled: true\nnext: done\n",
      value: { items: [{ mounts: [{ source: "x", targets: ["y", "z"] }], enabled: true }], next: "done" },
    },
    {
      name: "empty sequence items and comments",
      content: "items: # header\n# gap\n-\n- x\nnext: done\n",
      indented: "items: # header\n# gap\n  -\n  - x\nnext: done\n",
      value: { items: [null, "x"], next: "done" },
    },
  ];

  test.each(cases)("preserves the projected value for $name", ({ content, indented, value }) => {
    // Given / When
    const document = parse(content);
    // Then
    expect(document.value).toEqual(value);
    expect(document.value).toEqual(parse(indented).value);
  });

  test("preserves each scalar item span without comments or indentation", () => {
    // Given
    const content = "services:\n  appserver:\n    volumes:\n    - ./:/site\n    - ./conf:/etc/conf # tail\n";
    // When
    const { root } = parse(content);
    // Then
    if (root?.kind !== "mapping") throw new Error("Expected root mapping");
    const services = root.entries[0]?.value;
    if (services?.kind !== "mapping") throw new Error("Expected services mapping");
    const appserver = services.entries[0]?.value;
    if (appserver?.kind !== "mapping") throw new Error("Expected appserver mapping");
    const volumes = appserver.entries[0]?.value;
    if (volumes?.kind !== "sequence") throw new Error("Expected volumes sequence");
    expect(volumes.items.map(({ span }) => span)).toEqual([
      { start: { line: 4, column: 7, offset: 42 }, end: { line: 4, column: 15, offset: 50 } },
      { start: { line: 5, column: 7, offset: 57 }, end: { line: 5, column: 23, offset: 73 } },
    ]);
    expect(volumes.items.map(({ span }) => content.slice(span.start.offset, span.end.offset))).toEqual([
      "./:/site",
      "./conf:/etc/conf",
    ]);
    expect(volumes.span).toEqual({
      start: { line: 4, column: 7, offset: 42 },
      end: { line: 5, column: 23, offset: 73 },
    });
  });

  test("preserves mapping item and entry spans inside a sequence of mappings", () => {
    // Given
    const content = "- volumes:\n  - source: x\n    target: y\n  - source: z\n    target: w\n  type: php\n";
    // When
    const { root } = parse(content);
    // Then
    if (root?.kind !== "sequence") throw new Error("Expected root sequence");
    const service = root.items[0];
    if (service?.kind !== "mapping") throw new Error("Expected service mapping");
    const volumes = service.entries[0]?.value;
    if (volumes?.kind !== "sequence") throw new Error("Expected volumes sequence");
    expect(volumes.items.map(({ span }) => span)).toEqual([
      { start: { line: 2, column: 5, offset: 15 }, end: { line: 3, column: 14, offset: 38 } },
      { start: { line: 4, column: 5, offset: 43 }, end: { line: 5, column: 14, offset: 66 } },
    ]);
    expect(volumes.items.map(({ span }) => content.slice(span.start.offset, span.end.offset))).toEqual([
      "source: x\n    target: y",
      "source: z\n    target: w",
    ]);
    const first = volumes.items[0];
    if (first?.kind !== "mapping") throw new Error("Expected mount mapping");
    expect(first.entries.map(({ span }) => content.slice(span.start.offset, span.end.offset))).toEqual([
      "source: x",
      "target: y",
    ]);
  });

  test("retains anchors, aliases, and inert tags on indentationless sequences", () => {
    // Given
    const content = "items: &items !custom\n- &item x\n- *item\ncopy: *items\n";
    // When
    const document = parse(content);
    // Then
    expect(document.tags.map(({ tag, path }) => ({ tag, path }))).toEqual([
      { tag: "!custom", path: ["items"] },
    ]);
    expect(document.root).toMatchObject({
      entries: [
        {
          value: {
            kind: "sequence",
            anchor: "items",
            tag: "!custom",
            items: [
              { anchor: "item", text: "x" },
              { kind: "alias", name: "item" },
            ],
          },
        },
        { value: { kind: "alias", name: "items" } },
      ],
    });
  });

  const invalid = [
    ["services:\n  volumes:\n - x\n", 3, 2],
    ["volumes:\n  source: x\n  - y\n", 3, 3],
    ["volumes:\n  source: x\n  - target: y\n", 3, 3],
    ["volumes:\n  - x\n  source: y\n", 3, 3],
    ["volumes:\n  - x\n- y\n", 3, 1],
    ["volumes:\n- x\n - y\n", 3, 2],
    ["- volumes:\n - x\n", 2, 2],
    ["volumes: x\n- source: y\n", 2, 1],
  ] as const;
  test.each(invalid)("rejects invalid indentation for %j", (content, line, column) => {
    // Given / When
    const result = Effect.runSync(
      Effect.result(parseLegacyLandofile({ mode: "legacy", file: "bad.yml", content })),
    );
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "LandofileParseError", filePath: "bad.yml", line, column },
    });
    if (result._tag !== "Failure") throw new Error("Expected parse failure");
    expect(result.failure).toBeInstanceOf(LandofileParseError);
    expect(result.failure.remediation?.length).toBeGreaterThan(10);
  });

  test("enforces depth limits on indentationless sequence nodes", () => {
    // Given / When
    const result = Effect.runSync(
      Effect.result(
        parseLegacyLandofile({
          mode: "legacy",
          file: "deep.yml",
          content: "items:\n- x\n",
          limits: { maxDepth: 1 },
        }),
      ),
    );
    // Then
    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "LandofileParseError", line: 2, column: 1 },
    });
  });
});
