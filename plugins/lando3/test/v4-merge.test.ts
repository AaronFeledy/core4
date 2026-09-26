import { describe, expect, test } from "bun:test";
import {
  ARRAY_IDENTITY_KEYS,
  identityKeyFor,
  mergeLandofiles,
  mergeValues,
  routeFilterIdentity,
  routeFilterMatches,
} from "../src/v4-merge.ts";

describe("v4 merge port", () => {
  test("empty right array preserves a keyed left array", () => {
    expect(mergeValues([{ name: "a" }], [])).toEqual([{ name: "a" }]);
  });
  test("empty right array clears an unkeyed left array", () => {
    expect(mergeValues([{ value: "a" }], [])).toEqual([]);
  });
  test("deep merges maps in file order", () => {
    expect(mergeLandofiles([{ a: { x: 1, y: 2 } }, { a: { x: 3 } }])).toEqual({ a: { x: 3, y: 2 } });
  });
  test.each([
    [[1, 2], [1]],
    [[{ name: "a" }, 2], [{ name: "b" }]],
    [[{ name: "a" }], [{ other: "b" }]],
    [[{ other: "a" }], [{ name: "b" }]],
  ])("replaces nonidentity arrays %j with %j", (left, right) => {
    expect(mergeValues(left, right)).toEqual(right);
  });
  test.each([...ARRAY_IDENTITY_KEYS])("merges by %s", (key) => {
    expect(mergeValues([{ [key]: "a", x: 1 }], [{ [key]: "a", y: 2 }, { [key]: "b" }])).toEqual([
      { [key]: "a", x: 1, y: 2 },
      { [key]: "b" },
    ]);
  });
  test("selects the first owned identity and matches using the overlay key", () => {
    expect(identityKeyFor({ name: "a", id: "b" })).toBe("name");
    expect(mergeValues([{ name: "a", id: "b" }], [{ id: "b", x: 1 }])).toEqual([
      { name: "a", id: "b", x: 1 },
    ]);
  });
  test.each([{ name: "header", type: "responseHeader" }, { type: "responseHeader" }])(
    "merges filters by identity %j",
    (identity) => {
      expect(mergeValues([{ ...identity, header: "x" }], [{ ...identity, value: "y" }], "filters")).toEqual([
        { ...identity, header: "x", value: "y" },
      ]);
    },
  );
  test("named filters never match unnamed filters", () => {
    const unnamed = { type: "redirect" };
    const named = { name: "redirect", type: "redirect" };
    expect(routeFilterMatches(unnamed, named)).toBe(false);
    expect(mergeValues([unnamed], [named], "filters")).toEqual([unnamed, named]);
    expect(routeFilterIdentity({ name: undefined, type: "redirect" })).toEqual({
      kind: "name",
      value: undefined,
    });
  });
  test("replaces a named filter on type change", () => {
    expect(
      mergeValues(
        [{ name: "a", type: "redirect", to: "/" }],
        [{ name: "a", type: "addPrefix", prefix: "/x" }],
        "filters",
      ),
    ).toEqual([{ name: "a", type: "addPrefix", prefix: "/x" }]);
  });
  test("replaces filters lacking identity", () => {
    expect(mergeValues([{ type: "redirect" }], [{}], "filters")).toEqual([{}]);
  });
});
