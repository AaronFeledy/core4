import { describe, expect, test } from "bun:test";

import { checkedIndicesFromDefault, selectedChoiceIndex } from "../src/opentui/prompt-choice.ts";

const flavors = [
  { value: "vanilla", label: "Vanilla" },
  { value: "chocolate", label: "Chocolate" },
  { value: "strawberry", label: "Strawberry" },
];

// value 1 lives at index 1, so a literal-value match resolves differently than the 1-based index.
const ports = [
  { value: 3, label: "c" },
  { value: 1, label: "a" },
  { value: 2, label: "b" },
];

describe("prompt-choice default resolution", () => {
  test("checkedIndicesFromDefault resolves value and label tokens, not only indices", () => {
    expect([...checkedIndicesFromDefault(flavors, "vanilla,strawberry")].sort()).toEqual([0, 2]);
    expect([...checkedIndicesFromDefault(flavors, "Chocolate")].sort()).toEqual([1]);
    expect([...checkedIndicesFromDefault(flavors, "1,3")].sort()).toEqual([0, 2]);
  });

  test("numeric-valued choices match literal values before the index fallback", () => {
    expect([...checkedIndicesFromDefault(ports, "1")]).toEqual([1]);
    expect(selectedChoiceIndex(ports, "1")).toBe(1);
  });

  test("selectedChoiceIndex resolves value, label, then 1-based index", () => {
    expect(selectedChoiceIndex(flavors, "strawberry")).toBe(2);
    expect(selectedChoiceIndex(flavors, "Chocolate")).toBe(1);
    expect(selectedChoiceIndex(flavors, "2")).toBe(1);
    expect(selectedChoiceIndex(flavors, undefined)).toBe(0);
  });
});
