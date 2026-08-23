import { describe, expect, test } from "bun:test";
import path from "node:path";
import { collectImportBoundaryViolations } from "@lando/sdk/test";

const PACKAGE_ROOT = path.resolve(import.meta.dir, "..");

describe("@lando/sql import boundary", () => {
  test("does not import @lando/core, OCLIF, core CLI internals, or undeclared plugins", async () => {
    expect(await collectImportBoundaryViolations({ packageRoot: PACKAGE_ROOT })).toEqual([]);
  });
});
