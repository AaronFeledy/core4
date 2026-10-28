import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import {
  detectLandofileTags,
  emitLandofileYaml,
  override,
  parseLandofile,
  reset,
} from "@lando/sdk/landofile";

const file = "/app/.lando.yml";
const parse = (content: string, maxDepth?: number) =>
  Effect.runSync(
    parseLandofile({ file, content, cwd: "/app", limits: maxDepth === undefined ? {} : { maxDepth } }),
  );
const failure = (content: string, maxDepth?: number) => {
  const result = Effect.runSync(
    Effect.result(
      parseLandofile({ file, content, cwd: "/app", limits: maxDepth === undefined ? {} : { maxDepth } }),
    ),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") throw new Error("Expected a parse failure");
  expect(result.failure).toMatchObject({ _tag: "LandofileParseError", filePath: file });
  return result.failure;
};

const historical =
  "name: demo\nservices:\n  web:\n    type: compose\n    image: alpine\n    configs:\n      []\n";
const model = { name: "demo", services: { web: { type: "compose", image: "alpine", configs: [] } } };

describe("next-line Landofile flow collections", () => {
  test.each(["[]", "[ ]", "{}", "{ }"])("reads %s with comments, blank lines and siblings", (flow) => {
    expect(
      parse(`value: # payload follows\r\n\r\n  # comment only\r\n  ${flow} # end\r\nafter: true\r\n`),
    ).toEqual({
      value: flow.startsWith("[") ? [] : {},
      after: true,
    });
  });

  test("reads the historical Bun writer output and current writers", () => {
    expect(parse(historical)).toEqual(model);
    expect(parse(Bun.YAML.stringify(model, null, 2))).toEqual(model);
    expect(parse(emitLandofileYaml(model))).toEqual(model);
  });

  test("reads first and later keys in list-item maps", () => {
    expect(
      parse("items:\n  - first:\n      []\n    later:\n      {}\n    after: ok\n  - first:\n      [1, 2]\n"),
    ).toEqual({
      items: [{ first: [], later: {}, after: "ok" }, { first: [1, 2] }],
    });
  });

  test("binds block anchors on mapping members and list items", () => {
    expect(parse("base: &base\n  [1, 2]\ncopy: *base\nitems:\n  - &empty\n    {}\n  - *empty\n")).toEqual({
      base: [1, 2],
      copy: [1, 2],
      items: [{}, {}],
    });
  });

  test.each([
    {
      flow: '[8080:80, [1, false, null], {}, "quoted # hash", "a,b"]',
      value: ["8080:80", [1, false, null], {}, "quoted # hash", "a,b"],
    },
    { flow: "[a}, b]", value: ["a}", "b"] },
    {
      flow: '[8080:80, http://example.test/path, ${HOME}, "a: b", ?plain]',
      value: ["8080:80", "http://example.test/path", "${HOME}", "a: b", "?plain"],
    },
    { flow: `[don't, a"b, x[y, a{b]`, value: ["don't", 'a"b', "x[y", "a{b"] },
    {
      flow: "[&nested [1, 2], *nested]",
      value: [
        [1, 2],
        [1, 2],
      ],
    },
    { flow: "[1, [2,],]", value: [1, [2]] },
  ])("preserves supported values in $flow", ({ flow, value }) => {
    expect(parse(`value:\n  ${flow}\nafter: true\n`)).toEqual({ value, after: true });
    expect(parse(`value: ${flow}\n`)).toEqual({ value });
  });

  test.each([
    "[",
    "[}",
    "[[]",
    "[] trailing",
    "[][]",
    '["unterminated]',
    "[a,,b]",
    "[a]x]",
    "[a]]",
    "[,a]",
    "[{} trailing]",
    "{",
    "{} trailing",
    "{}{}",
    '["a" "b"]',
  ])("rejects malformed boundaries in %s inline and on the next line", (flow) => {
    failure(`value: ${flow}\n`);
    expect(failure(`value:\n  ${flow}\n`)).toMatchObject({ line: 2, column: 3 });
  });

  test.each(["value:\n  []\n  []\n", "value:\n  []\n    hidden: true\n", "value:\n  [\n    1\n  ]\n"])(
    "rejects extra or multiline child nodes %j",
    (content) => {
      failure(content);
    },
  );

  test.each(["scalar", "*alias", "!reset", "|", ">"])("keeps unsupported next-line %s rejected", (child) => {
    failure(`value:\n  ${child}\n`);
  });

  test.each(["[]\n", "{}\n", "- []\n"])("keeps root mappings required for %j", (content) => {
    failure(content);
  });

  test("keeps populated map rejection and parent remediation at the physical location", () => {
    const error = failure("healthcheck:\n  {disable: true, timeout: 5s}\n");
    expect(error).toMatchObject({ line: 2, column: 3 });
    expect(failure("healthcheck:\n  # comment\n\n  {disable: true}\n")).toMatchObject({ line: 4, column: 3 });
    expect(error.remediation).toBe(
      "Rewrite the flow mapping as a block mapping:\nhealthcheck:\n  disable: true\n  timeout: 5s",
    );
    const rewrite = error.remediation?.split("\n").slice(1).join("\n") ?? "";
    expect(parse(rewrite)).toEqual({ healthcheck: { disable: true, timeout: "5s" } });
    expect(failure("value:\n  [[{a: 1}]]\n")).toMatchObject({ line: 2, column: 5 });
  });

  test.each(['[{"a": 1}]', '[{a: "}, {", b: 2}]'])(
    "preserves populated mapping diagnostics through %s",
    (flow) => {
      const error = failure(`value:\n  ${flow}\n`);
      expect(error).toMatchObject({ line: 2, column: 4 });
      expect(error.message).toMatch(/Inline objects/);
      expect(error.remediation).toMatch(/block mapping/);
    },
  );

  test.each(["[a: b]", "[a:]", "[a:, b]", "[[a: b]]", '["a": b]', "[? a]", "[?]"])(
    "rejects unsupported implicit flow mapping %s",
    (flow) => {
      for (const content of [`value: ${flow}\n`, `value:\n  ${flow}\n`]) {
        const error = failure(content);
        expect(error.message).toMatch(/flow mapping/i);
        expect(error.remediation).toMatch(/block mapping/i);
      }
    },
  );

  test.each(["a:", "a?", "a:b", "a?:b:"])("preserves punctuation in flow alias names %s", (name) => {
    const base = `base: &${name} foo\n`;
    expect(parse(`${base}value: [*${name}]\n`)).toEqual({ base: "foo", value: ["foo"] });
    expect(parse(`${base}value:\n  [*${name}]\n`)).toEqual({ base: "foo", value: ["foo"] });
    expect(parse(`${base}value: &array [*${name}]\ncopy: *array\n`)).toEqual({
      base: "foo",
      value: ["foo"],
      copy: ["foo"],
    });
  });

  test.each([0, 1, 2, 3, 4])("matches inline depth limits at %i", (maxDepth) => {
    for (const flow of ["[]", "{}", "[[1]]", "[[[]]]"]) {
      const result = (content: string) =>
        Effect.runSync(
          Effect.result(
            parseLandofile({
              file,
              content,
              cwd: "/app",
              limits: maxDepth === undefined ? {} : { maxDepth },
            }),
          ),
        );
      for (const [inlineContent, nextLineContent] of [
        [`value: ${flow}\n`, `value:\n  ${flow}\n`],
        [`items:\n  - value: ${flow}\n`, `items:\n  - value:\n      ${flow}\n`],
        [`value: &base ${flow}\ncopy: *base\n`, `value: &base\n  ${flow}\ncopy: *base\n`],
        [`value: !override ${flow}\n`, `value: !override\n  ${flow}\n`],
      ]) {
        const inline = result(inlineContent ?? "");
        const nextLine = result(nextLineContent ?? "");
        expect(nextLine._tag).toBe(inline._tag);
        if (inline._tag === "Success" && nextLine._tag === "Success")
          expect(nextLine.success).toEqual(inline.success);
      }
    }
  });

  test.each([
    { content: "value:\n  [*missing]\n", line: 2, column: 4, message: /Unknown/ },
    { content: "value:\n  [*later]\nlater: &later []\n", line: 2, column: 4, message: /Unknown/ },
    { content: "value: &self\n  [*self]\n", line: 2, column: 4, message: /recursive/ },
    { content: "base: &same []\nvalue:\n  [&same []]\n", line: 3, column: 4, message: /Duplicate/ },
  ])("retains reference diagnostics for $content", ({ content, line, column, message }) => {
    const error = failure(content);
    expect(error).toMatchObject({ line, column });
    expect(error.message).toMatch(message);
  });

  test("retains mapping directives with next-line payloads", () => {
    expect(parse("a: !override\n  []\nb: !override\n  {}\nc: !reset\n  []\nd: !reset\n  {}\n")).toEqual({
      a: override([]),
      b: override({}),
      c: reset(),
      d: reset(),
    });
    expect(failure("value: !reset\n  [1]\n").message).toMatch(/populated/);
    expect(failure("value: !reset\n  {a: 1}\n").message).toMatch(/block mapping/);
    failure("value:\n  [!reset]\n");
  });

  test("detects standalone flow tags and skips block scalar bodies", () => {
    expect(
      detectLandofileTags({ file, content: "value:\n  [a}, !reset]\nliteral: |\n  [!override]\n" }),
    ).toEqual([{ tag: "!reset", line: 2, column: 8 }]);
  });

  test("keeps __proto__ as an own property", () => {
    const result = parse("__proto__:\n  []\nvalue:\n  [{}]\n") as Record<string, unknown>;
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(result.__proto__).toEqual([]);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });
});
