import { describe, expect, test } from "bun:test";
import { Either } from "effect";

import { getAtPath, setAtPath, unsetAtPath } from "../../../src/cli/config-write/dot-path.ts";
import { type ValueType, parseTypedValue } from "../../../src/cli/config-write/value-parse.ts";

const right = (raw: string, type: ValueType): unknown => {
  const result = parseTypedValue(raw, type);
  if (Either.isLeft(result)) throw new Error(`expected Right, got Left: ${result.left.message}`);
  return result.right;
};
const isLeft = (raw: string, type: ValueType): boolean => Either.isLeft(parseTypedValue(raw, type));

describe("dot-path get/set/unset round-trip", () => {
  test("getAtPath reads nested dot paths", () => {
    const obj = { services: { web: { type: "php" } } };
    expect(getAtPath(obj, "services.web.type")).toBe("php");
    expect(getAtPath(obj, "services.web.missing")).toBeUndefined();
    expect(getAtPath(obj, "nope.here")).toBeUndefined();
  });

  test("setAtPath creates intermediate maps immutably", () => {
    const obj = { name: "app" };
    const next = setAtPath(obj, "services.web.type", "php");
    expect(next).toEqual({ name: "app", services: { web: { type: "php" } } });
    // original untouched (immutable)
    expect(obj).toEqual({ name: "app" });
  });

  test("setAtPath overwrites an existing value", () => {
    const obj = { services: { web: { type: "php" } } };
    const next = setAtPath(obj, "services.web.type", "node");
    expect(getAtPath(next, "services.web.type")).toBe("node");
  });

  test("unsetAtPath removes a key and reports changed", () => {
    const obj = { services: { web: { type: "php", port: 80 } } };
    const { next, changed } = unsetAtPath(obj, "services.web.port");
    expect(changed).toBe(true);
    expect(getAtPath(next, "services.web.port")).toBeUndefined();
    expect(getAtPath(next, "services.web.type")).toBe("php");
  });

  test("unsetAtPath on a missing path is a no-op (changed:false)", () => {
    const obj = { services: { web: { type: "php" } } };
    const { next, changed } = unsetAtPath(obj, "services.db.type");
    expect(changed).toBe(false);
    expect(next).toEqual(obj);
  });
});

describe("bracket array indexing", () => {
  test("getAtPath reads array indices", () => {
    const obj = { tooling: { test: { cmds: ["a", "b", "c"] } } };
    expect(getAtPath(obj, "tooling.test.cmds[1]")).toBe("b");
    expect(getAtPath(obj, "tooling.test.cmds[9]")).toBeUndefined();
  });

  test("setAtPath writes into an array index", () => {
    const obj = { tooling: { test: { cmds: ["a", "b"] } } };
    const next = setAtPath(obj, "tooling.test.cmds[0]", "z");
    expect(getAtPath(next, "tooling.test.cmds[0]")).toBe("z");
    expect(getAtPath(next, "tooling.test.cmds[1]")).toBe("b");
  });

  test("setAtPath creates arrays for a leading bracket segment", () => {
    const next = setAtPath({}, "ports[0]", 8080);
    expect(next).toEqual({ ports: [8080] });
  });

  test("unsetAtPath removes an array element", () => {
    const obj = { ports: [80, 443, 8080] };
    const { next, changed } = unsetAtPath(obj, "ports[1]");
    expect(changed).toBe(true);
    expect((next as { ports: number[] }).ports).toEqual([80, 8080]);
  });
});

describe("parseTypedValue rejects malformed", () => {
  test("string is identity default", () => {
    expect(right("php:8.3", "string")).toBe("php:8.3");
  });

  test("number parses finite numbers, rejects NaN", () => {
    expect(right("80", "number")).toBe(80);
    expect(isLeft("nope", "number")).toBe(true);
  });

  test("boolean accepts only true/false", () => {
    expect(right("true", "boolean")).toBe(true);
    expect(right("false", "boolean")).toBe(false);
    expect(isLeft("yes", "boolean")).toBe(true);
  });

  test("json parses structured values, rejects malformed", () => {
    expect(right('["php","8.3"]', "json")).toEqual(["php", "8.3"]);
    expect(isLeft("{bad", "json")).toBe(true);
  });

  test("yaml parses scalars and json-compatible flow", () => {
    expect(right("php", "yaml")).toBe("php");
    expect(right("80", "yaml")).toBe(80);
    expect(right("true", "yaml")).toBe(true);
    expect(right("null", "yaml")).toBe(null);
    expect(right('["php","8.3"]', "yaml")).toEqual(["php", "8.3"]);
  });
});
