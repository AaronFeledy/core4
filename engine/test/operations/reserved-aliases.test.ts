import { describe, expect, test } from "bun:test";

import { CommandAliasConflictError } from "@lando/sdk/errors";

import { reservedToolingNameConflict } from "../../src/operations/reserved-aliases.ts";

describe("reservedToolingNameConflict", () => {
  test("returns CommandAliasConflictError for the reserved run name", () => {
    // Given
    const name = "run";
    const claimedBy = "service type php task run";

    // When
    const conflict = reservedToolingNameConflict(name, claimedBy);

    // Then
    expect(conflict).toBeInstanceOf(CommandAliasConflictError);
    expect(conflict).toMatchObject({
      alias: "run",
      claimedBy: "service type php task run",
      reservedFor: "apps:scratch:run",
    });
  });

  test("returns undefined for an unreserved tooling name", () => {
    // Given
    const name = "composer";
    const claimedBy = "service type php task composer";

    // When
    const conflict = reservedToolingNameConflict(name, claimedBy);

    // Then
    expect(conflict).toBeUndefined();
  });

  test("returns CommandAliasConflictError for the reserved scratch name", () => {
    // Given
    const name = "scratch";
    const claimedBy = "service type php task scratch";

    // When
    const conflict = reservedToolingNameConflict(name, claimedBy);

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
    const claimedBy = "service type php task scratch:gc";

    // When
    const conflict = reservedToolingNameConflict(name, claimedBy);

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
    const claimedBy = "service type php task scratchpad";

    // When
    const conflict = reservedToolingNameConflict(name, claimedBy);

    // Then
    expect(conflict).toBeUndefined();
  });
});
