import { describe, expect, test } from "bun:test";
import { Either } from "effect";

import {
  type CallExpressionNode,
  type ExpressionNode,
  type ExpressionTemplate,
  type ShellParamSegment,
  parseExpressionEither,
} from "@lando/sdk/expressions";

const filePath = "/app/.lando.yml";

const parseTemplate = (
  source: string,
  options: Partial<Parameters<typeof parseExpressionEither>[1]> = {},
): ExpressionTemplate => {
  const result = parseExpressionEither(source, { filePath, ...options });
  if (Either.isLeft(result)) {
    throw result.left;
  }
  return result.right;
};

const interpolationExpression = (source: string): ExpressionNode => {
  const template = parseTemplate(source);
  expect(template.segments).toHaveLength(1);
  const segment = template.segments[0];
  expect(segment?.kind).toBe("InterpolationSegment");
  if (segment?.kind !== "InterpolationSegment") {
    throw new Error("expected interpolation segment");
  }
  return segment.expression;
};

const callExpression = (source: string): CallExpressionNode => {
  const expression = interpolationExpression(source);
  expect(expression.kind).toBe("Call");
  if (expression.kind !== "Call") {
    throw new Error("expected call expression");
  }
  return expression;
};

const expectPath = (expression: ExpressionNode, head: string): void => {
  expect(expression.kind).toBe("Path");
  if (expression.kind !== "Path") return;
  expect(expression.head).toBe(head);
};

const shellSegments = (source: string): ReadonlyArray<ShellParamSegment> =>
  parseTemplate(source).segments.filter(
    (segment): segment is ShellParamSegment => segment.kind === "ShellParamSegment",
  );

const helperCases: ReadonlyArray<{
  readonly callee: string;
  readonly suffix: string;
  readonly expectedArgs: number;
}> = [
  { callee: "default", suffix: "(fallback)", expectedArgs: 2 },
  { callee: "required", suffix: '("message")', expectedArgs: 2 },
  { callee: "eq", suffix: "(other)", expectedArgs: 2 },
  { callee: "ne", suffix: "(other)", expectedArgs: 2 },
  { callee: "lt", suffix: "(other)", expectedArgs: 2 },
  { callee: "gt", suffix: "(other)", expectedArgs: 2 },
  { callee: "and", suffix: "(other)", expectedArgs: 2 },
  { callee: "or", suffix: "(other)", expectedArgs: 2 },
  { callee: "not", suffix: "", expectedArgs: 1 },
  { callee: "contains", suffix: "(needle)", expectedArgs: 2 },
  { callee: "startsWith", suffix: '("pre")', expectedArgs: 2 },
  { callee: "endsWith", suffix: '("post")', expectedArgs: 2 },
  { callee: "lower", suffix: "", expectedArgs: 1 },
  { callee: "upper", suffix: "", expectedArgs: 1 },
  { callee: "trim", suffix: "", expectedArgs: 1 },
  { callee: "split", suffix: '(",")', expectedArgs: 2 },
  { callee: "join", suffix: '(",")', expectedArgs: 2 },
  { callee: "replace", suffix: '("a", "b")', expectedArgs: 3 },
  { callee: "regexMatch", suffix: '("^a")', expectedArgs: 2 },
  { callee: "length", suffix: "", expectedArgs: 1 },
  { callee: "slice", suffix: "(1, 2)", expectedArgs: 3 },
  { callee: "keys", suffix: "", expectedArgs: 1 },
  { callee: "values", suffix: "", expectedArgs: 1 },
  { callee: "entries", suffix: "", expectedArgs: 1 },
  { callee: "get", suffix: '("key")', expectedArgs: 2 },
  { callee: "merge", suffix: "(other)", expectedArgs: 2 },
  { callee: "range", suffix: "(10)", expectedArgs: 2 },
  { callee: "map", suffix: "(mapper)", expectedArgs: 2 },
  { callee: "filter", suffix: "(predicate)", expectedArgs: 2 },
  { callee: "json", suffix: "", expectedArgs: 1 },
  { callee: "fromJson", suffix: "", expectedArgs: 1 },
  { callee: "yaml", suffix: "", expectedArgs: 1 },
  { callee: "fromYaml", suffix: "", expectedArgs: 1 },
  { callee: "fromToml", suffix: "", expectedArgs: 1 },
  { callee: "b64encode", suffix: "", expectedArgs: 1 },
  { callee: "b64decode", suffix: "", expectedArgs: 1 },
  { callee: "load", suffix: "", expectedArgs: 1 },
  { callee: "import", suffix: "", expectedArgs: 1 },
  { callee: "text", suffix: "", expectedArgs: 1 },
  { callee: "bytes", suffix: "", expectedArgs: 1 },
  { callee: "hash", suffix: '("sha256")', expectedArgs: 2 },
  { callee: "shellQuote", suffix: "", expectedArgs: 1 },
  { callee: "shellJoin", suffix: "", expectedArgs: 1 },
  { callee: "which", suffix: "", expectedArgs: 1 },
  { callee: "glob", suffix: "", expectedArgs: 1 },
  { callee: "path.join", suffix: '("child")', expectedArgs: 2 },
  { callee: "path.dirname", suffix: "", expectedArgs: 1 },
  { callee: "path.basename", suffix: "", expectedArgs: 1 },
  { callee: "path.extname", suffix: "", expectedArgs: 1 },
  { callee: "path.relative", suffix: "(from)", expectedArgs: 2 },
  { callee: "path.resolve", suffix: '("child")', expectedArgs: 2 },
  { callee: "fs.exists", suffix: "", expectedArgs: 1 },
  { callee: "fs.isFile", suffix: "", expectedArgs: 1 },
  { callee: "fs.isDir", suffix: "", expectedArgs: 1 },
  { callee: "fs.size", suffix: "", expectedArgs: 1 },
  { callee: "url.build", suffix: "", expectedArgs: 1 },
  { callee: "url.parse", suffix: "", expectedArgs: 1 },
  { callee: "semver.satisfies", suffix: '("^1.0.0")', expectedArgs: 2 },
  { callee: "semver.compare", suffix: '("1.2.3")', expectedArgs: 2 },
];

describe("parseExpression helper and filter calls", () => {
  for (const helper of helperCases) {
    test(`parses pipe helper ${helper.callee}`, () => {
      const call = callExpression(`{{ input | ${helper.callee}${helper.suffix} }}`);

      expect(call.callee).toBe(helper.callee);
      expect(call.args).toHaveLength(helper.expectedArgs);
      expectPath(call.args[0] ?? { kind: "Literal", value: null }, "input");
    });
  }

  test("parses pipe and call forms to identical call AST", () => {
    const pipe = interpolationExpression("{{ x | f(a) }}");
    const call = interpolationExpression("{{ f(x, a) }}");

    expect(pipe).toEqual(call);
  });

  test("composes filter chains", () => {
    const call = callExpression("{{ app.name | upper | trim }}");

    expect(call.callee).toBe("trim");
    const upper = call.args[0];
    expect(upper?.kind).toBe("Call");
    if (upper?.kind !== "Call") return;
    expect(upper.callee).toBe("upper");
    const path = upper.args[0];
    expect(path?.kind).toBe("Path");
    if (path?.kind !== "Path") return;
    expect(path.head).toBe("app");
    expect(path.segments).toEqual([{ type: "prop", name: "name" }]);
  });
});

describe("parseExpression paths and literals", () => {
  test("parses dotted, numeric, string-key, and dynamic path segments", () => {
    const expression = interpolationExpression('{{ service.endpoints[0].ports["http"][env.LOOKUP_KEY] }}');

    expect(expression.kind).toBe("Path");
    if (expression.kind !== "Path") return;
    expect(expression.head).toBe("service");
    expect(expression.segments).toEqual([
      { type: "prop", name: "endpoints" },
      { type: "index", index: 0 },
      { type: "prop", name: "ports" },
      { type: "key", key: "http" },
      {
        type: "dynamic",
        expr: { kind: "Path", head: "env", segments: [{ type: "prop", name: "LOOKUP_KEY" }] },
      },
    ]);
  });

  for (const [label, newline] of [
    ["CRLF", "\r\n"],
    ["lone CR", "\r"],
    ["lone LF", "\n"],
  ] as const) {
    test(`preserves raw ${label} inside string literals`, () => {
      const expression = interpolationExpression(`{{ "before${newline}after" }}`);

      expect(expression).toEqual({ kind: "Literal", value: `before${newline}after` });
    });
  }

  test("parses scalar, array, and object literals", () => {
    const expression = interpolationExpression(
      '{{ ["x", 1, true, false, null, { k: service.name, "x-key": vars["my-key"] }] }}',
    );

    expect(expression.kind).toBe("ArrayLiteral");
    if (expression.kind !== "ArrayLiteral") return;
    expect(expression.elements).toHaveLength(6);
    expect(expression.elements.slice(0, 5)).toEqual([
      { kind: "Literal", value: "x" },
      { kind: "Literal", value: 1 },
      { kind: "Literal", value: true },
      { kind: "Literal", value: false },
      { kind: "Literal", value: null },
    ]);
    const object = expression.elements[5];
    expect(object?.kind).toBe("ObjectLiteral");
    if (object?.kind !== "ObjectLiteral") return;
    expect(object.entries).toEqual([
      {
        key: "k",
        value: { kind: "Path", head: "service", segments: [{ type: "prop", name: "name" }] },
      },
      {
        key: "x-key",
        value: { kind: "Path", head: "vars", segments: [{ type: "key", key: "my-key" }] },
      },
    ]);
  });
});

describe("parseExpression template segments", () => {
  test("parses all braced shell parameter operators", () => {
    const segments = shellSegments(
      "${VAR} ${EMPTY:-default} ${UNSET-default} ${REQUIRED:?message} ${ALT:+alt}",
    );

    expect(segments).toEqual([
      { kind: "ShellParamSegment", name: "VAR", operator: "plain" },
      { kind: "ShellParamSegment", name: "EMPTY", operator: "default-empty", word: "default" },
      { kind: "ShellParamSegment", name: "UNSET", operator: "default-unset", word: "default" },
      { kind: "ShellParamSegment", name: "REQUIRED", operator: "error", word: "message" },
      { kind: "ShellParamSegment", name: "ALT", operator: "alt", word: "alt" },
    ]);
  });

  test("parses bare shell parameters with maximal identifier munch", () => {
    const template = parseTemplate("$VAR $VARx- $OTHER!");

    expect(template.segments).toEqual([
      { kind: "ShellParamSegment", name: "VAR", operator: "plain" },
      { kind: "LiteralSegment", text: " " },
      { kind: "ShellParamSegment", name: "VARx", operator: "plain" },
      { kind: "LiteralSegment", text: "- " },
      { kind: "ShellParamSegment", name: "OTHER", operator: "plain" },
      { kind: "LiteralSegment", text: "!" },
    ]);
  });

  test("parses secret references", () => {
    const template = parseTemplate("${secret:API_KEY}");

    expect(template.segments).toEqual([{ kind: "SecretRefSegment", name: "API_KEY" }]);
  });

  test("applies template escapes before interpolation and shell detection", () => {
    const template = parseTemplate("{{{{ and $${VAR}");

    expect(template.segments).toEqual([{ kind: "LiteralSegment", text: "{{ and ${VAR}" }]);
  });

  test("sets trim marker flags", () => {
    const template = parseTemplate("{{- x -}}");
    const segment = template.segments[0];

    expect(segment?.kind).toBe("InterpolationSegment");
    if (segment?.kind !== "InterpolationSegment") return;
    expect(segment.trimLeft).toBe(true);
    expect(segment.trimRight).toBe(true);
  });

  test("parses comment segments", () => {
    const template = parseTemplate("a{{# hidden #}}b");

    expect(template.segments).toEqual([
      { kind: "LiteralSegment", text: "a" },
      { kind: "CommentSegment", text: " hidden " },
      { kind: "LiteralSegment", text: "b" },
    ]);
  });

  test("marks whole templates only when the only segment is an interpolation", () => {
    expect(parseTemplate("{{ x }}").whole).toBe(true);
    expect(parseTemplate("a {{ x }}").whole).toBe(false);
    expect(parseTemplate(" {{ x }}").whole).toBe(false);
  });
});

describe("parseExpression operators", () => {
  const operatorCases: ReadonlyArray<readonly [string, string]> = [
    ["==", "eq"],
    ["!=", "ne"],
    ["<", "lt"],
    [">", "gt"],
    ["<=", "le"],
    [">=", "ge"],
    ["&&", "and"],
    ["||", "or"],
  ];

  for (const [operator, callee] of operatorCases) {
    test(`desugars ${operator} to ${callee} call`, () => {
      const call = callExpression(`{{ a ${operator} b }}`);

      expect(call.callee).toBe(callee);
      expect(call.args).toHaveLength(2);
      expectPath(call.args[0] ?? { kind: "Literal", value: null }, "a");
      expectPath(call.args[1] ?? { kind: "Literal", value: null }, "b");
    });
  }

  test("desugars unary not to a not call", () => {
    const call = callExpression("{{ !a }}");

    expect(call.callee).toBe("not");
    expect(call.args).toHaveLength(1);
    expectPath(call.args[0] ?? { kind: "Literal", value: null }, "a");
  });

  test("parses pipe more tightly than comparators", () => {
    const call = callExpression("{{ a == b | f }}");

    expect(call.callee).toBe("eq");
    expectPath(call.args[0] ?? { kind: "Literal", value: null }, "a");
    const filtered = call.args[1];
    expect(filtered?.kind).toBe("Call");
    if (filtered?.kind !== "Call") return;
    expect(filtered.callee).toBe("f");
    expectPath(filtered.args[0] ?? { kind: "Literal", value: null }, "b");
  });

  test("parses ternary as a Conditional node", () => {
    const expression = interpolationExpression("{{ app.name ? upper(app.name) : null }}");

    expect(expression.kind).toBe("Conditional");
    if (expression.kind !== "Conditional") return;
    expectPath(expression.test, "app");
    expect(expression.consequent.kind).toBe("Call");
    expect(expression.alternate).toEqual({ kind: "Literal", value: null });
  });
});

describe("parseExpression errors", () => {
  const expectExpressionError = (
    source: string,
    options: Partial<Parameters<typeof parseExpressionEither>[1]>,
    expected: { readonly line: number; readonly column: number },
  ): void => {
    const result = parseExpressionEither(source, { filePath, ...options });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isRight(result)) return;
    expect(result.left._tag).toBe("LandofileExpressionParseError");
    expect(result.left.filePath).toBe(filePath);
    expect(result.left.line).toBe(expected.line);
    expect(result.left.column).toBe(expected.column);
  };

  test("rejects a namespaced function reference without a call", () => {
    const result = parseExpressionEither("{{ path.join }}", { filePath });

    expect(Either.isLeft(result)).toBe(true);
    if (Either.isRight(result)) return;
    expect(result.left._tag).toBe("LandofileExpressionParseError");
    expect(result.left.filePath).toBe(filePath);
    expect(result.left.line).toBe(1);
    expect(result.left.column).toBe(4);
  });

  test("reports first-line errors with the base column offset", () => {
    expectExpressionError("{{ @ }}", { line: 4, column: 10 }, { line: 4, column: 13 });
  });

  test("reports multiline errors with the base line offset", () => {
    expectExpressionError("literal\n{{ @ }}", { line: 20, column: 10 }, { line: 21, column: 4 });
  });
});
