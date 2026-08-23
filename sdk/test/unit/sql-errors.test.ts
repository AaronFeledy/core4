import { describe, expect, test } from "bun:test";

import { Schema } from "effect";

import {
  SqlCommandFailedError,
  SqlConfirmRequiredError,
  SqlServiceAmbiguousError,
  SqlServiceNotFoundError,
} from "@lando/sdk/errors";

describe("SqlServiceNotFoundError", () => {
  test("encodes and decodes with _tag intact when a requested service is missing", () => {
    const error = new SqlServiceNotFoundError({
      message: "No SQL service named cache.",
      service: "cache",
      available: ["database", "postgres"],
      remediation: "Pass --service database.",
    });

    expect(error._tag).toBe("SqlServiceNotFoundError");
    expect(Schema.is(SqlServiceNotFoundError)(error)).toBe(true);

    const encoded = Schema.encodeUnknownSync(SqlServiceNotFoundError)(error);
    const decoded = Schema.decodeUnknownSync(SqlServiceNotFoundError)(encoded);

    expect(decoded._tag).toBe("SqlServiceNotFoundError");
    expect(decoded.service).toBe("cache");
    expect(decoded.available).toEqual(["database", "postgres"]);
    expect(decoded.remediation).toBe("Pass --service database.");
  });

  test("omits optional service when no requested name was given", () => {
    const error = new SqlServiceNotFoundError({
      message: "No SQL service is available.",
      available: [],
      remediation: "Add a database service to the Landofile.",
    });

    expect(error._tag).toBe("SqlServiceNotFoundError");
    expect(error.service).toBeUndefined();
    expect(Schema.is(SqlServiceNotFoundError)(error)).toBe(true);
  });
});

describe("SqlServiceAmbiguousError", () => {
  test("encodes and decodes with _tag intact when multiple SQL services exist", () => {
    const error = new SqlServiceAmbiguousError({
      message: "Multiple SQL services are available.",
      available: ["database", "postgres"],
      remediation: "Pass --service to select one.",
    });

    expect(error._tag).toBe("SqlServiceAmbiguousError");
    expect(Schema.is(SqlServiceAmbiguousError)(error)).toBe(true);

    const encoded = Schema.encodeUnknownSync(SqlServiceAmbiguousError)(error);
    const decoded = Schema.decodeUnknownSync(SqlServiceAmbiguousError)(encoded);

    expect(decoded._tag).toBe("SqlServiceAmbiguousError");
    expect(decoded.available).toEqual(["database", "postgres"]);
    expect(decoded.remediation).toBe("Pass --service to select one.");
  });
});

describe("SqlConfirmRequiredError", () => {
  test("encodes and decodes with _tag intact when confirmation is required", () => {
    const error = new SqlConfirmRequiredError({
      message: "Confirmation is required before dropping the database.",
      service: "database",
      steps: [
        {
          id: "drop",
          label: "Drop database",
          target: "database",
          destructive: true,
        },
      ],
      remediation: "Re-run with --yes.",
    });

    expect(error._tag).toBe("SqlConfirmRequiredError");
    expect(Schema.is(SqlConfirmRequiredError)(error)).toBe(true);

    const encoded = Schema.encodeUnknownSync(SqlConfirmRequiredError)(error);
    const decoded = Schema.decodeUnknownSync(SqlConfirmRequiredError)(encoded);

    expect(decoded._tag).toBe("SqlConfirmRequiredError");
    expect(decoded.service).toBe("database");
    expect(decoded.steps).toEqual([
      {
        id: "drop",
        label: "Drop database",
        target: "database",
        destructive: true,
      },
    ]);
    expect(decoded.remediation).toBe("Re-run with --yes.");
  });
});

describe("SqlCommandFailedError", () => {
  test("encodes and decodes with _tag intact when an in-service command fails", () => {
    const error = new SqlCommandFailedError({
      message: "Database command failed in database.",
      service: "database",
      command: ["mysql", "-e", "DROP DATABASE app"],
      remediation: "Inspect the service logs, then retry the import, export, or reset.",
    });

    expect(error._tag).toBe("SqlCommandFailedError");
    expect(Schema.is(SqlCommandFailedError)(error)).toBe(true);

    const encoded = Schema.encodeUnknownSync(SqlCommandFailedError)(error);
    const decoded = Schema.decodeUnknownSync(SqlCommandFailedError)(encoded);

    expect(decoded._tag).toBe("SqlCommandFailedError");
    expect(decoded.service).toBe("database");
    expect(decoded.command).toEqual(["mysql", "-e", "DROP DATABASE app"]);
  });
});
