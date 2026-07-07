import { describe, expect, test } from "bun:test";

import { CommandAliasConflictError } from "@lando/sdk/errors";

import { EmptyResultSchema, validateCommandSpec } from "../../src/cli/oclif/command-base.ts";
import { assertToolingNameClaimable, reservedTopLevelAliasOwner } from "../../src/cli/reserved-aliases.ts";

describe("reservedTopLevelAliasOwner", () => {
  test("reserves the bare run alias for apps:scratch:run", () => {
    expect(reservedTopLevelAliasOwner("run")).toBe("apps:scratch:run");
  });

  test("reserves scratch and scratch:* for the apps:scratch namespace", () => {
    expect(reservedTopLevelAliasOwner("scratch")).toBe("apps:scratch:start");
    expect(reservedTopLevelAliasOwner("scratch:run")).toBe("apps:scratch:run");
    expect(reservedTopLevelAliasOwner("scratch:gc")).toBe("apps:scratch:gc");
  });

  test("leaves unreserved aliases unclaimed", () => {
    expect(reservedTopLevelAliasOwner("start")).toBeUndefined();
    expect(reservedTopLevelAliasOwner("composer")).toBeUndefined();
    expect(reservedTopLevelAliasOwner("runner")).toBeUndefined();
  });
});

describe("validateCommandSpec alias reservation", () => {
  test("rejects a foreign command spec claiming the bare run alias", () => {
    expect(() =>
      validateCommandSpec({
        id: "app:my-plugin-cmd",
        resultSchema: EmptyResultSchema,
        topLevelAlias: "run",
      }),
    ).toThrow(CommandAliasConflictError);
  });

  test("rejects a foreign command spec claiming a scratch:* alias", () => {
    expect(() =>
      validateCommandSpec({
        id: "app:my-plugin-cmd",
        resultSchema: EmptyResultSchema,
        topLevelAlias: ["scratch:mine"],
      }),
    ).toThrow(CommandAliasConflictError);
  });

  test("allows the owning built-in to claim its reserved aliases", () => {
    expect(() =>
      validateCommandSpec({
        id: "apps:scratch:run",
        resultSchema: EmptyResultSchema,
        topLevelAlias: ["scratch:run", "run"],
      }),
    ).not.toThrow();
    expect(() =>
      validateCommandSpec({
        id: "apps:scratch:start",
        resultSchema: EmptyResultSchema,
        topLevelAlias: ["scratch:start", "scratch"],
      }),
    ).not.toThrow();
  });
});

describe("assertToolingNameClaimable", () => {
  test("fails a tooling task claiming run with CommandAliasConflictError", async () => {
    expect(() => assertToolingNameClaimable("run", "tooling task run")).toThrow(CommandAliasConflictError);
  });

  test("accepts ordinary tooling task names", () => {
    expect(() => assertToolingNameClaimable("composer", "tooling task composer")).not.toThrow();
    expect(() => assertToolingNameClaimable("scratchpad", "tooling task scratchpad")).not.toThrow();
  });
});
