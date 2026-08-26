import { describe, expect, test } from "bun:test";
import { parse } from "@gabrielbryk/jq-ts";

import { assertJqExpressionSafe } from "../../src/cli/jq/jq-ts-guard.ts";

const REJECTED = /unbounded index or allocation/;

const assertThrows = (expr: string): void => {
  const ast = parse(expr);
  expect(() => assertJqExpressionSafe(ast)).toThrow(REJECTED);
};

const assertAllows = (expr: string): void => {
  const ast = parse(expr);
  expect(() => assertJqExpressionSafe(ast)).not.toThrow();
};

describe("assertJqExpressionSafe", () => {
  test("rejects huge index assignment", () => {
    assertThrows(".[999999999] = 0");
  });

  test("rejects huge string multiply", () => {
    assertThrows('"a" * 1000000000');
  });

  test("allows huge index lookup without assignment", () => {
    assertAllows(".[999999999]");
  });

  test("rejects setpath with huge index", () => {
    assertThrows("setpath([999999999]; 0)");
  });

  test("allows setpath with huge value that is not an index", () => {
    assertAllows("setpath([1]; 1000000)");
  });

  test("allows small multiply", () => {
    assertAllows("1 * 2");
  });

  test("allows string multiply below threshold", () => {
    assertAllows('"x" * 999999');
  });

  test("rejects string multiply at threshold", () => {
    assertThrows('"x" * 1000000');
  });
});
