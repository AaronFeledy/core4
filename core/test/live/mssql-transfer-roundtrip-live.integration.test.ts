import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeResultFrameEnvelope } from "./convergence-cli.ts";
import {
  databaseJourneyTimeout,
  databaseTransferFixture,
  mssqlTransferLandofile,
} from "./database-transfer-fixture.ts";
import { liveEnabled } from "./scanner-live-fixture.ts";

for (const version of ["2019", "2022"] as const) {
  test.skipIf(!liveEnabled)(
    `MSSQL ${version} canonical consumer credentials survive backup restore and warm startup`,
    async () => {
      const fixture = await databaseTransferFixture(`mssql-${version}-roundtrip`);
      const { root, lando, marker } = fixture;
      try {
        // Given catalog startup owns database creation and the consumer has only projected credentials.
        await Bun.write(join(root, ".lando.yml"), mssqlTransferLandofile(fixture, version));
        const started = await lando(["start", "--format=json"]);
        expect(started.exitCode, started.artifact).toBe(0);
        const catalog = [
          "sqlcmd",
          "--",
          "-b",
          "-h",
          "-1",
          "-W",
          "-d",
          "master",
          "-Q",
          "SET NOCOUNT ON; SELECT CONCAT(database_id, '|', CONVERT(varchar(30), create_date, 126)) FROM sys.databases WHERE database_id = DB_ID(N'transfer_journey');",
        ];
        const initialCatalog = await lando(catalog);
        expect(initialCatalog.exitCode, initialCatalog.artifact).toBe(0);
        expect(initialCatalog.stdout.trim()).toMatch(/^\d+\|\d{4}-\d{2}-\d{2}T/u);
        const seeded = await lando([
          "consumer-query",
          "--",
          `CREATE TABLE transfer_probe (value varchar(80)); INSERT INTO transfer_probe VALUES ('${marker}');`,
        ]);
        expect(seeded.exitCode, seeded.artifact).toBe(0);
        const exported = await lando([
          "db:export",
          "roundtrip.bak.gz",
          "--service=database",
          "--yes",
          "--format=json",
        ]);
        expect(exported.exitCode, exported.artifact).toBe(0);
        expect(decodeResultFrameEnvelope(exported.stdout).ok, exported.artifact).toBe(true);
        const backup = await readFile(join(root, "roundtrip.bak.gz"));
        expect([...backup.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
        const modified = await lando(["consumer-query", "--", "UPDATE transfer_probe SET value = 'changed'"]);
        expect(modified.exitCode, modified.artifact).toBe(0);

        // When reset and import replace the database from the exported compressed backup.
        const reset = await lando(["db:reset", "--service=database", "--yes", "--format=json"]);
        expect(reset.exitCode, reset.artifact).toBe(0);
        const empty = await lando([
          "consumer-query",
          "--",
          "SET NOCOUNT ON; SELECT COUNT(*) FROM sys.tables WHERE name = 'transfer_probe'",
        ]);
        expect(empty.exitCode, empty.artifact).toBe(0);
        expect(empty.stdout.trim()).toBe("0");
        const imported = await lando([
          "db:import",
          "roundtrip.bak.gz",
          "--service=database",
          "--yes",
          "--format=json",
        ]);
        expect(imported.exitCode, imported.artifact).toBe(0);
        expect(decodeResultFrameEnvelope(imported.stdout).ok, imported.artifact).toBe(true);

        // Then the separate consumer reads the original row, including immediately after a warm start.
        const restored = await lando([
          "consumer-query",
          "--",
          "SET NOCOUNT ON; SELECT value FROM transfer_probe",
        ]);
        expect(restored.exitCode, restored.artifact).toBe(0);
        expect(restored.stdout.trim() === marker, restored.artifact).toBe(true);
        const beforeRestart = await lando(catalog);
        expect(beforeRestart.exitCode, beforeRestart.artifact).toBe(0);
        expect(beforeRestart.stdout.trim()).toMatch(/^\d+\|\d{4}-\d{2}-\d{2}T/u);
        const stopped = await lando(["stop", "--format=json"]);
        expect(stopped.exitCode, stopped.artifact).toBe(0);
        const restarted = await lando(["start", "--format=json"]);
        expect(restarted.exitCode, restarted.artifact).toBe(0);
        const persisted = await lando([
          "consumer-query",
          "--",
          "SET NOCOUNT ON; SELECT value FROM transfer_probe",
        ]);
        expect(persisted.exitCode, persisted.artifact).toBe(0);
        expect(persisted.stdout.trim() === marker, persisted.artifact).toBe(true);
        const afterRestart = await lando(catalog);
        expect(afterRestart.exitCode, afterRestart.artifact).toBe(0);
        expect(afterRestart.stdout.trim(), afterRestart.artifact).toBe(beforeRestart.stdout.trim());
      } finally {
        await fixture.cleanup();
      }
    },
    databaseJourneyTimeout,
  );
}
