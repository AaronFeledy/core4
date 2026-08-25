import { describe, expect, test } from "bun:test";

import { typeableName } from "../../src/cli/help-names.ts";

describe("typeableName", () => {
  test.each([
    {
      name: "implicit start from app:start",
      input: { canonicalId: "app:start", builtInAliases: ["start"] },
      primary: "start",
      extras: ["app:start"],
    },
    {
      name: "custom hi -> app:greet",
      input: {
        canonicalId: "app:greet",
        builtInAliases: ["greet"],
        aliasPolicy: { custom: { hi: "app:greet" } },
      },
      primary: "hi",
      extras: ["greet", "app:greet"],
    },
    {
      name: "disabled start falls back to app:start",
      input: {
        canonicalId: "app:start",
        builtInAliases: ["start"],
        aliasPolicy: { disabled: ["start"] },
      },
      primary: "app:start",
      extras: [] as const,
    },
    {
      name: "collision where custom remaps start away from app:start",
      input: {
        canonicalId: "app:start",
        builtInAliases: ["start"],
        aliasPolicy: { custom: { start: "app:greet" } },
      },
      primary: "app:start",
      extras: [] as const,
    },
  ])("selects $name", ({ input, primary, extras }) => {
    // Given a command id, its built-in aliases, and an optional alias policy
    // When the display name is resolved
    const result = typeableName(input);

    // Then the primary token follows custom > implicit > canonical
    expect(result.primary).toBe(primary);
    expect(result.extras).toEqual([...extras]);
  });

  test("returns implicit name when aliasPolicy is undefined", () => {
    // Given a namespaced id with no policy object
    const input = { canonicalId: "app:start", builtInAliases: ["start"] };

    // When the display name is resolved
    const result = typeableName(input);

    // Then aliases stay enabled and the stripped token wins
    expect(result.primary).toBe("start");
    expect(result.extras).toEqual(["app:start"]);
  });

  test("strips the namespace prefix when builtInAliases is empty", () => {
    const result = typeableName({ canonicalId: "app:greet", builtInAliases: [] });
    expect(result.primary).toBe("greet");
    expect(result.extras).toEqual(["app:greet"]);
  });

  test("returns the canonical id when aliases are disabled", () => {
    const result = typeableName({
      canonicalId: "app:start",
      builtInAliases: ["start"],
      aliasPolicy: { enabled: false },
    });
    expect(result.primary).toBe("app:start");
    expect(result.extras).toEqual([]);
  });
});
