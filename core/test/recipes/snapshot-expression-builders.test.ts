import { describe, expect, test } from "bun:test";
import {
  arr,
  call,
  cond,
  defaultRoute,
  lit,
  obj,
  toolNode,
} from "../../src/recipes/builtin/snapshot-expression.ts";

describe("snapshot expression builders", () => {
  test.each(["text", 42, true, null])("preserves literal value %j", (value) => {
    // Given a supported literal value; when building it.
    const node = lit(value);
    // Then the value and kind are unchanged.
    expect(node).toEqual({ kind: "Literal", value });
  });

  test("preserves the default route's ordered AST", () => {
    // Given the bundled route convention; when building it.
    const route = defaultRoute();
    // Then it matches the original literal, including entry order.
    expect(route).toEqual({
      kind: "ObjectLiteral",
      entries: [
        { key: "hostname", value: { kind: "Literal", value: "{{ app.name }}.{{ proxy.defaultDomain }}" } },
        { key: "scheme", value: { kind: "Literal", value: "both" } },
      ],
    });
  });

  test("allocates independent route subtrees for repeated calls", () => {
    // Given one route.
    const first = defaultRoute();
    // When building another route.
    const second = defaultRoute();
    // Then neither the root nor its entries or children are shared.
    expect(second).not.toBe(first);
    expect(second.entries).not.toBe(first.entries);
    for (const [index, entry] of second.entries.entries()) {
      expect(entry).not.toBe(first.entries[index]);
      expect(entry.value).not.toBe(first.entries[index]?.value);
    }
  });

  test("preserves numeric-looking object key order", () => {
    // Given intentionally nonnumeric ordering; when building the object.
    const node = obj([
      ["10", lit(1)],
      ["2", lit(2)],
    ]);
    // Then pairs retain their supplied order.
    expect(node.entries.map((entry) => entry.key)).toEqual(["10", "2"]);
  });

  test("wraps a string command in the original tooling shape", () => {
    // Given a service, description, and command; when building tooling.
    const node = toolNode("web", "d", "c");
    // Then the ordered service/description/cmds shape is unchanged.
    expect(node).toEqual({
      kind: "ObjectLiteral",
      entries: [
        { key: "service", value: { kind: "Literal", value: "web" } },
        { key: "description", value: { kind: "Literal", value: "d" } },
        { key: "cmds", value: { kind: "ArrayLiteral", elements: [{ kind: "Literal", value: "c" }] } },
      ],
    });
  });

  test("passes expression commands through beside literal commands", () => {
    // Given a command expression.
    const command = call("b64decode", lit("Yw=="));
    // When building mixed tooling commands.
    const node = toolNode("appserver", "d", ["first", command]);
    // Then the expression is not wrapped or copied.
    expect(node.entries[2]?.value).toEqual({
      kind: "ArrayLiteral",
      elements: [{ kind: "Literal", value: "first" }, command],
    });
    expect(node.entries[2]?.value).toHaveProperty("elements.1", command);
  });

  test("preserves array element order", () => {
    // Given two literals.
    const elements = [lit("a"), lit("b")];
    // When building an array.
    const node = arr(...elements);
    // Then the ordered elements retain their identities.
    expect(node).toEqual({ kind: "ArrayLiteral", elements });
    expect(node.elements[0]).toBe(elements[0]);
  });

  test("preserves call arguments and callee", () => {
    // Given two call arguments.
    const args = [lit(1), lit(2)];
    // When building a call.
    const node = call("eq", ...args);
    // Then its callee and ordered arguments are unchanged.
    expect(node).toEqual({ kind: "Call", callee: "eq", args });
  });

  test("preserves conditional branches", () => {
    // Given a test and distinct branches.
    const testNode = lit(true);
    const consequent = lit("yes");
    const alternate = lit("no");
    // When building a conditional.
    const node = cond(testNode, consequent, alternate);
    // Then branches keep their roles.
    expect(node).toEqual({ kind: "Conditional", test: testNode, consequent, alternate });
  });

  test.each([
    () => lit(null),
    () => arr(),
    () => obj([]),
    () => cond(lit(true), lit(1), lit(0)),
    () => call("eq", lit(1), lit(1)),
    () => toolNode("web", "d", "c"),
  ])("allocates a fresh node on every invocation", (build) => {
    // Given an earlier invocation.
    const first = build();
    // When invoking the same builder again.
    const second = build();
    // Then its node is never cached.
    expect(second).not.toBe(first);
  });
});
