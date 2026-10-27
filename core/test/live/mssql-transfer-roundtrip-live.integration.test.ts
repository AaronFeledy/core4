import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeInfoCliEnvelope } from "./convergence-cli.ts";
import {
  databaseJourneyTimeout,
  databaseTransferFixture,
  mssqlTransferLandofile,
} from "./database-transfer-fixture.ts";
import { countDatabaseCreationRecords } from "./database-transfer-logs.ts";
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
        const initialLogs = await lando(["logs", "--service=database", "--format=json"]);
        expect(initialLogs.exitCode, initialLogs.artifact).toBe(0);
        expect(
          countDatabaseCreationRecords(initialLogs.stdout, "transfer_journey"),
          initialLogs.artifact,
        ).toBe(1);
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
        expect(decodeInfoCliEnvelope(exported.stdout).ok, exported.artifact).toBe(true);
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
        expect(decodeInfoCliEnvelope(imported.stdout).ok, imported.artifact).toBe(true);

        // Then the separate consumer reads the original row, including immediately after a warm start.
        const restored = await lando([
          "consumer-query",
          "--",
          "SET NOCOUNT ON; SELECT value FROM transfer_probe",
        ]);
        expect(restored.exitCode, restored.artifact).toBe(0);
        expect(restored.stdout.trim() === marker, restored.artifact).toBe(true);
        const warmStartSince = new Date().toISOString();
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
        const warmLogs = await lando([
          "logs",
          "--service=database",
          `--since=${warmStartSince}`,
          "--format=json",
        ]);
        expect(warmLogs.exitCode, warmLogs.artifact).toBe(0);
        expect(countDatabaseCreationRecords(warmLogs.stdout, "transfer_journey"), warmLogs.artifact).toBe(0);
      } finally {
        await fixture.cleanup();
      }
    },
    databaseJourneyTimeout,
  );
}
