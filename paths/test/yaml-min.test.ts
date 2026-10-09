import { describe, expect, test } from "bun:test";

import { MinimalYamlError, parseMinimalYaml, parseScalar } from "../src/yaml-min.ts";

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

  test("keeps a hash that sits inside a double-quoted command", () => {
    expect(parseMinimalYaml('cmd: "echo a #b"')).toEqual({ cmd: "echo a #b" });
  });

  test("keeps a hash that sits inside a single-quoted command", () => {
    expect(parseMinimalYaml("cmd: 'echo a #b'")).toEqual({ cmd: "echo a #b" });
  });

  test("still strips a real comment after a quoted hash", () => {
    expect(parseMinimalYaml('cmd: "echo a #b" # trailing')).toEqual({ cmd: "echo a #b" });
  });

  test("strips an unquoted trailing comment", () => {
    expect(parseMinimalYaml("cmd: echo hello # comment")).toEqual({ cmd: "echo hello" });
  });

  test("does not treat an apostrophe in an unquoted value as a quote", () => {
    expect(parseMinimalYaml("a: Bob's laptop # note")).toEqual({ a: "Bob's laptop" });
  });

  test("keeps a hash that is not preceded by whitespace", () => {
    expect(parseMinimalYaml("cmd: x#y")).toEqual({ cmd: "x#y" });
  });

  test("keeps a URL fragment and strips the trailing comment", () => {
    expect(parseMinimalYaml("url: http://h/#frag # c")).toEqual({ url: "http://h/#frag" });
  });

  test("unescapes backslash quotes inside a double-quoted value", () => {
    expect(parseScalar('"echo \\"hi\\""')).toBe('echo "hi"');
    expect(parseMinimalYaml('cmd: "foo \\"bar\\" # inside" # c')).toEqual({ cmd: 'foo "bar" # inside' });
  });

  test("unescapes doubled apostrophes inside a single-quoted value", () => {
    expect(parseScalar("'Bob''s laptop'")).toBe("Bob's laptop");
  });

  test("keeps a hash inside an unterminated quoted value", () => {
    expect(parseMinimalYaml('cmd: "echo a #b')).toEqual({ cmd: '"echo a #b' });
  });
});
