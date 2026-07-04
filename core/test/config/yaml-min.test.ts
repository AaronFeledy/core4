import { describe, expect, test } from "bun:test";

import { MinimalYamlError, parseMinimalYaml, parseScalar } from "../../src/config/yaml-min.ts";

describe("parseScalar", () => {
  test("parses an inline flow array into a real array", () => {
    expect(parseScalar("[1,2]")).toEqual([1, 2]);
  });

  test("parses an inline flow object into a real object", () => {
    expect(parseScalar('{"a":1}')).toEqual({ a: 1 });
  });

  test("still rejects a flow-looking value that is not valid JSON", () => {
    expect(() => parseScalar("[this is not valid yaml subset")).toThrow(MinimalYamlError);
  });
});

describe("parseMinimalYaml", () => {
  test("round-trips a config value written as an inline flow array", () => {
    expect(parseMinimalYaml('plugins: ["foo","bar"]')).toEqual({ plugins: ["foo", "bar"] });
  });

  test("round-trips a config value written as an inline flow object", () => {
    expect(parseMinimalYaml('meta: {"a":1}')).toEqual({ meta: { a: 1 } });
  });
});
