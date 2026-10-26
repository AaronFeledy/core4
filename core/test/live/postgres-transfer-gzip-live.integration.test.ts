import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { decodeInfoCliEnvelope } from "./convergence-cli.ts";
import { databaseJourneyTimeout, databaseTransferFixture } from "./database-transfer-fixture.ts";
import { liveEnabled } from "./scanner-live-fixture.ts";

const transferFailure = Schema.Struct({
  _tag: Schema.Literal("DataTransferError"),
  exitCode: Schema.Number,
  stderrTail: Schema.NonEmptyString,
  recoverySnapshotId: Schema.optionalKey(Schema.NonEmptyString),
});
const snapshotListing = Schema.Struct({ snapshots: Schema.Array(Schema.Struct({ id: Schema.String })) });

test.skipIf(!liveEnabled)(
  "PostgreSQL SCRAM gzip transfers roundtrip rows and preserve an existing export on authentication failure",
  async () => {
    const fixture = await databaseTransferFixture("pg-gzip-transfer");
    const { root, name, secretId, marker, lando } = fixture;
    const query = ["psql", "--", "-h", "127.0.0.1", "-w", "-tAc"] as const;
    try {
      // Given TCP authentication requires the deferred secret rather than local trust.
      await Bun.write(
        join(root, ".lando.yml"),
        [
          `name: ${name}`,
          "runtime: 4",
          "provider: lando",
          "router:",
          "  enabled: false",
          "services:",
          "  database:",
          "    type: postgres:17",
          "    home: false",
          "    appMount: false",
          "    creds:",
          "      user: lando",
          "      database: transfer_journey",
          `      password: \${secret:${secretId}}`,
          "    environment:",
          "      PGHOST: 127.0.0.1",
          "      POSTGRES_INITDB_ARGS: --auth-host=scram-sha-256",
          "",
        ].join("\n"),
      );
      const started = await lando(["start", "--format=json"]);
      expect(started.exitCode, started.artifact).toBe(0);
      const seeded = await lando([
        ...query,
        `CREATE TABLE transfer_probe (value text); INSERT INTO transfer_probe VALUES ('${marker}');`,
      ]);
      expect(seeded.exitCode, seeded.artifact).toBe(0);

      // When a gzip dump replaces modified data through the public import command.
      const exported = await lando([
        "db:export",
        "roundtrip.sql.gz",
        "--service=database",
        "--yes",
        "--format=json",
      ]);
      expect(exported.exitCode, exported.artifact).toBe(0);
      expect(decodeInfoCliEnvelope(exported.stdout).ok, exported.artifact).toBe(true);
      const original = await readFile(join(root, "roundtrip.sql.gz"));
      expect([...original.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
      expect(Buffer.from(Bun.gunzipSync(original)).includes(Buffer.from(marker))).toBe(true);
      const modified = await lando([...query, "UPDATE transfer_probe SET value = 'changed'"]);
      expect(modified.exitCode, modified.artifact).toBe(0);
      const imported = await lando([
        "db:import",
        "roundtrip.sql.gz",
        "--service=database",
        "--yes",
        "--format=json",
      ]);
      expect(imported.exitCode, imported.artifact).toBe(0);
      expect(decodeInfoCliEnvelope(imported.stdout).ok, imported.artifact).toBe(true);
      const restored = await lando([...query, "SELECT value FROM transfer_probe"]);
      expect(restored.exitCode, restored.artifact).toBe(0);
      expect(restored.stdout.trim() === marker, restored.artifact).toBe(true);

      // Then a wrong runtime secret fails safely without replacing a single destination byte.
      const rejected = await lando(
        ["db:export", "roundtrip.sql.gz", "--service=database", "--yes", "--format=json"],
        fixture.wrongPassword,
      );
      expect(rejected.exitCode, rejected.artifact).toBe(1);
      const envelope = decodeInfoCliEnvelope(rejected.stdout);
      expect(envelope.ok, rejected.artifact).toBe(false);
      const failure = Schema.decodeUnknownSync(transferFailure)(envelope.error);
      expect(failure.exitCode).toBe(1);
      expect(failure.stderrTail).toMatch(/password authentication failed/i);
      expect(failure.recoverySnapshotId).toBeUndefined();
      expect(rejected.stdout.includes(marker), rejected.artifact).toBe(false);
      expect(await readFile(join(root, "roundtrip.sql.gz"))).toEqual(original);

      await Bun.write(
        join(root, "invalid.sql"),
        `SELECT '${fixture.invalidBackup}';\nSELECT * FROM deliberately_missing_relation;\n`,
      );
      const invalid = await lando([
        "db:import",
        "invalid.sql",
        "--service=database",
        "--yes",
        "--format=json",
      ]);
      expect(invalid.exitCode, invalid.artifact).toBe(1);
      const invalidEnvelope = decodeInfoCliEnvelope(invalid.stdout);
      expect(invalidEnvelope.ok, invalid.artifact).toBe(false);
      const invalidFailure = Schema.decodeUnknownSync(transferFailure)(invalidEnvelope.error);
      expect(invalidFailure.exitCode).toBe(3);
      expect(invalidFailure.recoverySnapshotId).toBeString();
      expect(invalid.stdout.includes(fixture.invalidBackup), invalid.artifact).toBe(false);
      const snapshots = await lando(["db:snapshots", "--service=database", "--format=json"]);
      expect(snapshots.exitCode, snapshots.artifact).toBe(0);
      const retained = Schema.decodeUnknownSync(snapshotListing)(
        decodeInfoCliEnvelope(snapshots.stdout).result,
      ).snapshots;
      expect(retained.some((snapshot) => snapshot.id === invalidFailure.recoverySnapshotId)).toBe(true);
    } finally {
      await fixture.cleanup();
    }
  },
  databaseJourneyTimeout,
);
