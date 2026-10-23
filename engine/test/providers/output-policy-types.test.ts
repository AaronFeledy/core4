import { expect, test } from "bun:test";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import type { providerMemberPolicy } from "../../src/providers/output-policy.ts";

test("the policy table classifies every required and optional provider member", () => {
  const assertType = <T extends true>(value: T) => value;
  type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
  expect(assertType<Equal<keyof typeof providerMemberPolicy, keyof RuntimeProviderShape>>(true)).toBe(true);
});
