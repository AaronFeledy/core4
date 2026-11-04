import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SnapshotInfo } from "@lando/sdk/schema";
import { Schema } from "effect";
import { decodeInfoCliEnvelope } from "./convergence-cli.ts";
import {
  databaseJourneyTimeout,
  databaseTransferFixture,
  mssqlTransferLandofile,
} from "./database-transfer-fixture.ts";
import { liveEnabled } from "./scanner-live-fixture.ts";

const sqlFailure = Schema.Struct({
  _tag: Schema.Literal("SqlCommandFailedError"),
  service: Schema.Literal("database"),
  command: Schema.Array(Schema.String),
  exitCode: Schema.Number,
  stderrTail: Schema.NonEmptyString,
  recoverySnapshotId: Schema.optionalKey(Schema.NonEmptyString),
});
const snapshotListing = Schema.Struct({ snapshots: Schema.Array(SnapshotInfo) });

for (const version of ["2019", "2022"] as const) {
  test.skipIf(!liveEnabled)(
    `MSSQL ${version} failed BACKUP publishes no stale dump and invalid RESTORE retains its recovery points`,
    async () => {
      const fixture = await databaseTransferFixture(`mssql-${version}-failure`);
      const { root, name, marker, invalidBackup, lando } = fixture;
      const admin = ["sqlcmd", "--", "-b", "-r1", "-d", "master", "-Q"] as const;
      try {
        // Given a real backup and a full automatic-recovery retention budget.
        await Bun.write(join(root, ".lando.yml"), mssqlTransferLandofile(fixture, version));
        const started = await lando(["start", "--format=json"]);
        expect(started.exitCode, started.artifact).toBe(0);
        for (let index = 0; index < 3; index++) {
          const reset = await lando(["db:reset", "--service=database", "--yes", "--format=json"]);
          expect(reset.exitCode, reset.artifact).toBe(0);
        }
        const seeded = await lando([
          "consumer-query",
          "--",
          `CREATE TABLE transfer_probe (value varchar(80)); INSERT INTO transfer_probe VALUES ('${marker}');`,
        ]);
        expect(seeded.exitCode, seeded.artifact).toBe(0);
        const exported = await lando([
          "db:export",
          "existing.bak",
          "--service=database",
          "--yes",
          "--format=json",
        ]);
        expect(exported.exitCode, exported.artifact).toBe(0);
        const original = await readFile(join(root, "existing.bak"));
        expect(original.byteLength).toBeGreaterThan(0);

        // When BACKUP itself fails against an offline database after a previous successful export.
        const offline = await lando([
          ...admin,
          "ALTER DATABASE [transfer_journey] SET OFFLINE WITH ROLLBACK IMMEDIATE",
        ]);
        expect(offline.exitCode, offline.artifact).toBe(0);
        for (const destination of ["fresh.bak", "existing.bak"]) {
          const failed = await lando([
            "db:export",
            destination,
            "--service=database",
            "--yes",
            "--format=json",
          ]);
          expect(failed.exitCode, failed.artifact).toBe(1);
          const envelope = decodeInfoCliEnvelope(failed.stdout);
          expect(envelope.ok, failed.artifact).toBe(false);
          const failure = Schema.decodeUnknownSync(sqlFailure)(envelope.error);
          expect(failure.exitCode).toBe(1);
          expect(failure.command.join(" ")).toContain("BACKUP DATABASE");
          expect(failure.recoverySnapshotId).toBeUndefined();
          expect(failed.stdout.includes(marker), failed.artifact).toBe(false);
        }
        expect(await Bun.file(join(root, "fresh.bak")).exists()).toBe(false);
        expect(await readFile(join(root, "existing.bak"))).toEqual(original);
        const online = await lando([...admin, "ALTER DATABASE [transfer_journey] SET ONLINE"]);
        expect(online.exitCode, online.artifact).toBe(0);
        const before = await lando(["db:snapshots", "--service=database", "--format=json"]);
        expect(before.exitCode, before.artifact).toBe(0);
        const prior = Schema.decodeUnknownSync(snapshotListing)(
          decodeInfoCliEnvelope(before.stdout).result,
        ).snapshots;
        expect(prior).toHaveLength(3);

        // Then invalid RESTORE keeps the primary SQL error and every prior recovery snapshot, not just three.
        await Bun.write(join(root, "invalid.bak"), invalidBackup);
        const rejected = await lando([
          "db:import",
          "invalid.bak",
          "--service=database",
          "--yes",
          "--format=json",
        ]);
        expect(rejected.exitCode, rejected.artifact).toBe(1);
        const envelope = decodeInfoCliEnvelope(rejected.stdout);
        expect(envelope.ok, rejected.artifact).toBe(false);
        expect(envelope.result).toBeUndefined();
        const failure = Schema.decodeUnknownSync(sqlFailure)(envelope.error);
        expect(failure.exitCode).toBe(1);
        expect(failure.command.join(" ")).toContain("RESTORE DATABASE");
        expect(failure.recoverySnapshotId).toBeString();
        for (const payload of [marker, invalidBackup]) {
          expect(rejected.stdout.includes(payload), rejected.artifact).toBe(false);
        }
        console.log(
          "DATABASE_TRANSFER_RECOVERY",
          JSON.stringify({ name, root, recoverySnapshotId: failure.recoverySnapshotId }),
        );
        const after = await lando(["db:snapshots", "--service=database", "--format=json"]);
        expect(after.exitCode, after.artifact).toBe(0);
        const retained = Schema.decodeUnknownSync(snapshotListing)(
          decodeInfoCliEnvelope(after.stdout).result,
        ).snapshots;
        expect(retained).toHaveLength(prior.length + 1);
        for (const snapshot of prior) expect(retained.map((item) => item.id)).toContain(snapshot.id);
        const recovery = retained.find((snapshot) => snapshot.id === failure.recoverySnapshotId);
        expect(recovery?.metadata?.recoveryReason).toBe("import");
      } finally {
        await fixture.cleanup();
      }
    },
    databaseJourneyTimeout,
  );
}
