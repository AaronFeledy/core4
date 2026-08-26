import { describe, expect, test } from "bun:test";

import { extractFormatFlags } from "../../src/cli/format-flags.ts";

describe("extractFormatFlags exec positional landmines", () => {
  test("does not steal echo after space-form --json on app:exec", () => {
    // Given app:exec with space-form --json before a positional command
    const argv = ["app:exec", "--json", "echo", "--", "hi"] as const;

    // When format flags are extracted
    const result = extractFormatFlags(argv);

    // Then echo stays positional: U1 only consumes space-form tokens that contain , or .
    expect(result.json).toBe(true);
    expect(result.jsonList).toBe(true);
    expect(result.jsonFields).toBeUndefined();
    expect(result.remainingArgv).toEqual(["app:exec", "echo", "--", "hi"]);
  });

  test("treats --json=echo as a one-key field list named echo", () => {
    // Given equals-form --json=echo on app:exec
    const argv = ["app:exec", "--json=echo", "--", "hi"] as const;

    // When format flags are extracted
    const result = extractFormatFlags(argv);

    // Then echo is a field list, not leftover argv
    expect(result.json).toBe(true);
    expect(result.jsonList).toBe(false);
    expect(result.jsonFields).toEqual(["echo"]);
    expect(result.remainingArgv).toEqual(["app:exec", "--", "hi"]);
  });
});
