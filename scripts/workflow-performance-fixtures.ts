import { createHash } from "node:crypto";

import type { WorkflowPerformanceFixtureFamily } from "./workflow-performance-plan.ts";

export type DatabaseFixture = {
  readonly family: WorkflowPerformanceFixtureFamily;
  readonly version: string;
  readonly seed: string;
  readonly rowCount: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly contents: string;
};

export type GenerateDatabaseFixtureOptions = {
  readonly family: WorkflowPerformanceFixtureFamily;
  readonly seed: string;
  readonly rowCount?: number;
};

const payloadFor = (seed: string, index: number): string =>
  createHash("sha256")
    .update(`${seed}:${String(index)}`)
    .digest("hex");

const mysqlFixture = (seed: string, rowCount: number): string => {
  const rows = Array.from(
    { length: rowCount },
    (_, index) => `(${String(index + 1)},'${payloadFor(seed, index)}')`,
  );
  return [
    "SET NAMES utf8mb4;",
    "DROP TABLE IF EXISTS `workflow_performance_fixture`;",
    "CREATE TABLE `workflow_performance_fixture` (`id` INT PRIMARY KEY, `payload` VARCHAR(64) NOT NULL);",
    `INSERT INTO \`workflow_performance_fixture\` (\`id\`, \`payload\`) VALUES\n${rows.join(",\n")};`,
    "",
  ].join("\n");
};

const postgresFixture = (seed: string, rowCount: number): string => {
  const rows = Array.from(
    { length: rowCount },
    (_, index) => `(${String(index + 1)},'${payloadFor(seed, index)}')`,
  );
  return [
    "BEGIN;",
    'DROP TABLE IF EXISTS "workflow_performance_fixture";',
    'CREATE TABLE "workflow_performance_fixture" ("id" INTEGER PRIMARY KEY, "payload" VARCHAR(64) NOT NULL);',
    `INSERT INTO "workflow_performance_fixture" ("id", "payload") VALUES\n${rows.join(",\n")};`,
    "COMMIT;",
    "",
  ].join("\n");
};

export const generateDatabaseFixture = (options: GenerateDatabaseFixtureOptions): DatabaseFixture => {
  const rowCount = options.rowCount ?? 256;
  const contents =
    options.family === "mysql"
      ? mysqlFixture(options.seed, rowCount)
      : postgresFixture(options.seed, rowCount);
  return {
    family: options.family,
    version: "1",
    seed: options.seed,
    rowCount,
    bytes: Buffer.byteLength(contents),
    sha256: createHash("sha256").update(contents).digest("hex"),
    contents,
  };
};
