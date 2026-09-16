import { describe, expect, test } from "bun:test";

import { generateDatabaseFixture } from "../../../scripts/workflow-performance-fixtures.ts";

describe("workflow performance database fixtures", () => {
  test("generates deterministic family-correct fixtures with bytes and SHA-256", () => {
    const mysql = generateDatabaseFixture({ family: "mysql", seed: "nightly", rowCount: 3 });
    const repeated = generateDatabaseFixture({ family: "mysql", seed: "nightly", rowCount: 3 });
    const postgres = generateDatabaseFixture({ family: "postgres", seed: "nightly", rowCount: 3 });

    expect(mysql).toEqual(repeated);
    expect(mysql.contents).toContain("`workflow_performance_fixture`");
    expect(postgres.contents).toContain('"workflow_performance_fixture"');
    expect(postgres.contents).toContain("BEGIN;");
    expect(mysql.sha256).toHaveLength(64);
    expect(mysql.bytes).toBe(Buffer.byteLength(mysql.contents));
    expect(postgres.sha256).not.toBe(mysql.sha256);
  });
});
