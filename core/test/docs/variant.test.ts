import { describe, expect, test } from "bun:test";

import { encodeVariantPair, encodeVariantString, variantFileSuffix } from "../../src/docs/variant.ts";

describe("variantFileSuffix", () => {
  test("empty variant yields empty suffix", () => {
    expect(variantFileSuffix("")).toBe("");
  });

  test("single pair retains axis=value", () => {
    expect(variantFileSuffix("php=v8-3")).toBe(".php=v8-3");
  });

  test("multiple pairs join axis=value segments with dots", () => {
    expect(variantFileSuffix("php=v8-3 database=mariadb")).toBe(".php=v8-3.database=mariadb");
  });

  test("malformed pair without = contributes empty segment", () => {
    expect(variantFileSuffix("php=v8-3 broken database=mariadb")).toBe(".php=v8-3..database=mariadb");
  });

  test("same value on different axes produces distinct suffixes", () => {
    // Given: two single-axis variants that share a value token.
    // When/Then: axis-preserving suffixes stay injective.
    expect(variantFileSuffix("php=v8-3")).toBe(".php=v8-3");
    expect(variantFileSuffix("database=v8-3")).toBe(".database=v8-3");
    expect(variantFileSuffix("php=v8-3")).not.toBe(variantFileSuffix("database=v8-3"));
  });
});

describe("encodeVariantPair / encodeVariantString", () => {
  test("encode round-trips through variantFileSuffix", () => {
    const pairs = [encodeVariantPair("php", "v8-3"), encodeVariantPair("database", "mariadb")];
    const encoded = encodeVariantString(pairs);
    expect(encoded).toBe("php=v8-3 database=mariadb");
    expect(variantFileSuffix(encoded)).toBe(".php=v8-3.database=mariadb");
  });
});
