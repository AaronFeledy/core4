import { describe, expect, test } from "bun:test";

import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { canonicalJson as recipeCanonicalJson } from "@lando/sdk/recipes";

describe("sha256Hex", () => {
  test("hashes a string to the FIPS 180-2 abc vector", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  test("hashes bytes identically to the equivalent string", () => {
    expect(sha256Hex(new TextEncoder().encode("abc"))).toBe(sha256Hex("abc"));
  });
});

describe("canonicalJson", () => {
  test("sorts object keys recursively while preserving array order", () => {
    expect(canonicalJson({ b: 1, a: [{ d: 1, c: 2 }] })).toBe('{"a":[{"c":2,"d":1}],"b":1}');
  });

  test("orders keys by UTF-16 code unit, not locale", () => {
    expect(canonicalJson({ a: 2, B: 1, 日本: 3, é: 4, z: null })).toBe(
      '{"B":1,"a":2,"z":null,"é":4,"日本":3}',
    );
  });

  test("omits undefined properties and nulls undefined array slots", () => {
    expect(canonicalJson({ x: undefined, y: [undefined, 1.5, -0, 1e21] })).toBe('{"y":[null,1.5,0,1e+21]}');
  });

  test("is the same function the recipes surface re-exports", () => {
    expect(recipeCanonicalJson).toBe(canonicalJson);
  });
});
