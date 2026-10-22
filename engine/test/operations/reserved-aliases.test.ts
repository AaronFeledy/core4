import { describe, expect, test } from "bun:test";

import { CommandAliasConflictError } from "@lando/sdk/errors";

import { reservedToolingNameConflict } from "../../src/operations/reserved-aliases.ts";

describe("reservedToolingNameConflict", () => {
  test("returns CommandAliasConflictError for the reserved run name", () => {
    // Given
    const name = "run";
    const serviceTypeId = "php";

    // When
    const conflict = reservedToolingNameConflict(name, serviceTypeId);

    // Then
    expect(conflict).toBeInstanceOf(CommandAliasConflictError);
    expect(conflict).toMatchObject({
      alias: "run",
      claimedBy: "service type php task run",
      reservedFor: "apps:scratch:run",
      remediation:
        "Set tooling.run.disabled: true in the Landofile to drop service type php's task, or redefine it under another name.",
    });
  });

  test("returns undefined for an unreserved tooling name", () => {
    // Given
    const name = "composer";
    const serviceTypeId = "php";

    // When
    const conflict = reservedToolingNameConflict(name, serviceTypeId);

    // Then
    expect(conflict).toBeUndefined();
  });

  test("returns CommandAliasConflictError for the reserved scratch name", () => {
    // Given
    const name = "scratch";
    const serviceTypeId = "php";

    // When
    const conflict = reservedToolingNameConflict(name, serviceTypeId);

    // Then
    expect(conflict).toBeInstanceOf(CommandAliasConflictError);
    expect(conflict).toMatchObject({
      alias: "scratch",
      claimedBy: "service type php task scratch",
      reservedFor: "apps:scratch:start",
    });
  });

  test("returns CommandAliasConflictError for a reserved scratch: prefix name", () => {
    // Given
    const name = "scratch:gc";
    const serviceTypeId = "php";

    // When
    const conflict = reservedToolingNameConflict(name, serviceTypeId);

    // Then
    expect(conflict).toBeInstanceOf(CommandAliasConflictError);
    expect(conflict).toMatchObject({
      alias: "scratch:gc",
      claimedBy: "service type php task scratch:gc",
      reservedFor: "apps:scratch:gc",
    });
  });

  test("returns undefined for a name that only shares a scratch prefix", () => {
    // Given
    const name = "scratchpad";
    const serviceTypeId = "php";

    // When
    const conflict = reservedToolingNameConflict(name, serviceTypeId);

    // Then
    expect(conflict).toBeUndefined();
  });

  test("authored reserved tooling remediation never suggests remapping an alias", () => {
    // Given
    const name = "run";
    // When
    const conflict = reservedToolingNameConflict(name);
    // Then
    expect(conflict).toMatchObject({
      claimedBy: "tooling task run",
      remediation: "Rename tooling task run; run belongs to apps:scratch:run.",
    });
  });
});
