import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { retireTempRoots } from "@lando/engine/testing/temp-root-retirement";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Schema } from "effect";
import { databaseTransferFixture } from "./database-transfer-fixture.ts";

const cliTimeout = 120_000;
const journeyTimeout = 10 * cliTimeout;
const snapshotListing = Schema.Struct({
  snapshots: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      label: Schema.optionalKey(Schema.String),
      metadata: Schema.optionalKey(Schema.Struct({ recoveryReason: Schema.optionalKey(Schema.String) })),
    }),
  ),
});
const snapshotCreated = Schema.Struct({ snapshotId: Schema.String });
// MariaDB 11.4 prints this on every client run unless certificate verification is disabled explicitly.
const tlsWarning = /warning: option --ssl-verify-server-cert is disabled/i;
const readJourney = ["mariadb", "-N", "-B", "-e", "SELECT value FROM journey"] as const;
// Streaming commands prefix the result envelope with event lines and a result frame.
const streamed = Schema.Struct({ _tag: Schema.Literal("result"), envelope: CommandResultEnvelope });
const decodeOutput = Schema.decodeUnknownSync(Schema.Union([CommandResultEnvelope, streamed]));
const lastEnvelope = (output: string) => {
  const parsed = decodeOutput(JSON.parse(output.trim().split("\n").at(-1) ?? ""));
  return "_tag" in parsed ? parsed.envelope : parsed;
};

// Each provider needs its own explicit opt-in, matching the other live suites.
const providers = [
  {
    id: "docker",
    socketPath:
      process.env.LANDO_TEST_DOCKER_SOCKET === "/var/run/docker.sock" ? "/var/run/docker.sock" : undefined,
  },
  { id: "podman", socketPath: resolveLiveProviderSocket()?.socketPath },
] as const;

for (const provider of providers) {
  test.skipIf(provider.socketPath === undefined)(
    `MariaDB snapshot, restore, export, and import preserve data on the ${provider.id} provider`,
    async () => {
      if (provider.socketPath === undefined) throw new Error(`A live ${provider.id} socket is required.`);
      const directory = await mkdtemp(join(tmpdir(), `lando-mariadb-journey-${provider.id}-`));
      const env = {
        ...process.env,
        LANDO_USER_CONF_ROOT: join(directory, "config"),
        LANDO_USER_DATA_ROOT: join(directory, "data"),
        LANDO_USER_CACHE_ROOT: join(directory, "cache"),
        LANDO_SYSTEM_PLUGIN_ROOT: join(directory, "system-plugins"),
        LANDO_PROVIDER: provider.id,
        LANDO_CONFIG__default_provider_id: provider.id,
        LANDO_TEST_PODMAN_SOCKET: provider.id === "podman" ? provider.socketPath : undefined,
        DOCKER_HOST: `unix://${provider.socketPath}`,
        LANDO_TELEMETRY_ENABLED: "false",
      };
      const binary = process.env.LANDO_SCENARIO_E2E_BINARY;
      const command =
        binary === undefined
          ? ([process.execPath, resolve(import.meta.dir, "../../bin/lando.ts")] as const)
          : ([binary] as const);
      try {
        let listedSnapshotCount: number | undefined;
        const fixture = await databaseTransferFixture(`mariadb-${provider.id}-journey`, {
          env,
          afterDestroy: async (destroyed) => {
            // A failure before the listing already reports its own cause.
            if (listedSnapshotCount === undefined) return;
            // Then the purge removed every snapshot the journey listed.
            expect(listedSnapshotCount).toBeGreaterThanOrEqual(2);
            expect(destroyed.snapshotsRemoved, JSON.stringify(destroyed)).toBe(listedSnapshotCount);
          },
        });
        const { root, name, secretId, marker } = fixture;
        try {
          // Given a single MariaDB service on the selected real provider.
          await Bun.write(
            join(root, ".lando.yml"),
            [
              `name: ${name}`,
              "runtime: 4",
              `provider: ${provider.id}`,
              "agentEnv: false",
              "sshAgent:",
              "  sidecar: false",
              "gpgAgent:",
              "  forward: false",
              "router:",
              "  enabled: false",
              "services:",
              "  db:",
              "    type: mariadb:11.4",
              "    home: false",
              "    appMount: false",
              "    creds:",
              `      password: \${secret:${secretId}}`,
              "",
            ].join("\n"),
          );
          const started = await fixture.lando(["start", "--format=json"]);
          expect(started.exitCode, started.artifact).toBe(0);
          expect(lastEnvelope(started.stdout).ok, started.artifact).toBe(true);

          // When a seeded row is snapshotted, mutated away, and restored through the public commands.
          const seeded = await fixture.lando([
            "mariadb",
            "-e",
            `CREATE TABLE journey (value varchar(64)); INSERT INTO journey VALUES ('${marker}');`,
          ]);
          expect(seeded.exitCode, seeded.artifact).toBe(0);
          expect(seeded.stderr, seeded.artifact).not.toMatch(tlsWarning);

          const snapshotted = await fixture.lando([
            "db:snapshot",
            "--label",
            "base",
            "--service=db",
            "--format=json",
          ]);
          expect(snapshotted.exitCode, snapshotted.artifact).toBe(0);
          const snapshotEnvelope = lastEnvelope(snapshotted.stdout);
          expect(snapshotEnvelope.ok, snapshotted.artifact).toBe(true);
          expect(Schema.decodeUnknownSync(snapshotCreated)(snapshotEnvelope.result).snapshotId).toBeString();

          const mutated = await fixture.lando([
            "mariadb",
            "-e",
            "DELETE FROM journey; INSERT INTO journey VALUES ('mutated');",
          ]);
          expect(mutated.exitCode, mutated.artifact).toBe(0);

          const restored = await fixture.lando([
            "db:restore",
            "base",
            "--yes",
            "--service=db",
            "--format=json",
          ]);
          expect(restored.exitCode, restored.artifact).toBe(0);
          expect(lastEnvelope(restored.stdout).ok, restored.artifact).toBe(true);

          // Then the row the snapshot holds is back, replacing the mutation.
          const afterRestore = await fixture.lando(readJourney);
          expect(afterRestore.exitCode, afterRestore.artifact).toBe(0);
          expect(afterRestore.stdout, afterRestore.artifact).toContain(marker);
          expect(afterRestore.stdout, afterRestore.artifact).not.toContain("mutated");

          // When the restored database is exported to a file and imported back through that file.
          const exported = await fixture.lando([
            "db:export",
            "journey.sql.gz",
            "--service=db",
            "--yes",
            "--format=json",
          ]);
          expect(exported.exitCode, exported.artifact).toBe(0);
          expect(lastEnvelope(exported.stdout).ok, exported.artifact).toBe(true);
          expect(await Bun.file(join(root, "journey.sql.gz")).exists()).toBe(true);

          const imported = await fixture.lando([
            "db:import",
            "journey.sql.gz",
            "--service=db",
            "--yes",
            "--format=json",
          ]);
          expect(imported.exitCode, imported.artifact).toBe(0);
          expect(lastEnvelope(imported.stdout).ok, imported.artifact).toBe(true);

          // Then listings expose the manual snapshot and an automatic import recovery snapshot.
          const listed = await fixture.lando(["db:snapshots", "--service=db", "--format=json"]);
          expect(listed.exitCode, listed.artifact).toBe(0);
          const listedEnvelope = lastEnvelope(listed.stdout);
          expect(listedEnvelope.ok, listed.artifact).toBe(true);
          const listings = Schema.decodeUnknownSync(snapshotListing)(listedEnvelope.result).snapshots;
          listedSnapshotCount = listings.length;
          expect(
            listings.some((snapshot) => snapshot.label === "base"),
            listed.artifact,
          ).toBe(true);
          expect(
            listings.some((snapshot) => snapshot.metadata?.recoveryReason === "import"),
            listed.artifact,
          ).toBe(true);

          const afterImport = await fixture.lando(readJourney);
          expect(afterImport.exitCode, afterImport.artifact).toBe(0);
          expect(afterImport.stdout, afterImport.artifact).toContain(marker);
        } finally {
          await fixture.cleanup();
        }
      } finally {
        const retirement = await retireTempRoots({ directory, env, endpoint: provider.socketPath, command });
        expect(
          [...retirement.retained, ...retirement.failed],
          JSON.stringify({ directory, ...retirement }),
        ).toEqual([]);
      }
    },
    journeyTimeout + 240_000,
  );
}
