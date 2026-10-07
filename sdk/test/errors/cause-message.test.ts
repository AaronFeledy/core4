import { expect, test } from "bun:test";

import { causeMessage } from "@lando/sdk/errors";

test.each([
  [new Error("m"), "m"],
  ["s", "s"],
  [42, "42"],
  [undefined, "undefined"],
  [null, "null"],
  [{ message: "not an Error" }, "[object Object]"],
])("describes %p without an Error prefix", (cause, expected) => {
  // Given the cause above.
  // When describing it.
  const result = causeMessage(cause);
  // Then Errors use their message and other values use String.
  expect(result).toBe(expected);
});
