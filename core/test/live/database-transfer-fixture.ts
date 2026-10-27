import { expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Effect } from "effect";
import { decodeInfoCliEnvelope, runFixtureCli } from "./convergence-cli.ts";

export const databaseJourneyTimeout = 30 * 120_000 + 60_000;
const cliEntry = resolve(import.meta.dir, "../../bin/lando.ts");

// The shared child runner owns process cleanup; this fixture adds database-only
// secret-safe artifacts and app/snapshot teardown, which that runner does not own.
export const databaseTransferFixture = async (label: string) => {
  const root = await mkdtemp(join(tmpdir(), `lando-${label}-`));
  const name = `${label}-${crypto.randomUUID().slice(0, 8)}`;
  // An external root is caller-owned and survives app cleanup, including on failure.
  const artifactRoot = process.env.LANDO_TEST_ARTIFACT_ROOT || root;
  const secretId = `DB_TRANSFER_${crypto.randomUUID().replaceAll("-", "_")}`;
  const password = `DbTransfer!9-${crypto.randomUUID()}`;
  const wrongPassword = `WrongTransfer!9-${crypto.randomUUID()}`;
  const marker = `row-${crypto.randomUUID()}`;
  const invalidBackup = `invalid-backup-${crypto.randomUUID()}`;
  const redact = (text: string) =>
    [password, wrongPassword, marker, invalidBackup].reduce(
      (safe, value) => safe.replaceAll(value, "[redacted]"),
      text,
    );
  let invocation = 0;
  const lando = async (args: readonly string[], credential = password) => {
    const binary = process.env.LANDO_SCENARIO_E2E_BINARY;
    const { BUN_BE_BUN: _bunBeBun, ...inherited } = process.env;
    const result = await Effect.runPromise(
      runFixtureCli([...(binary === undefined ? [process.execPath, cliEntry] : [binary]), ...args], root, {
        ...inherited,
        LANDO_TELEMETRY_ENABLED: "false",
        [`LANDO_SECRET_${secretId}`]: credential,
      }),
    );
    const artifact = join(artifactRoot, `${name}-cli-${++invocation}.json`);
    await Bun.write(artifact, redact(JSON.stringify({ args, ...result })));
    for (const secret of [password, wrongPassword]) {
      expect((result.stdout + result.stderr).includes(secret), `Credential disclosed; ${artifact}`).toBe(
        false,
      );
    }
    return { ...result, artifact };
  };
  console.log("DATABASE_TRANSFER_CREATED", JSON.stringify({ name, root }));
  return {
    root,
    name,
    secretId,
    password,
    wrongPassword,
    marker,
    invalidBackup,
    lando,
    async cleanup() {
      console.log("DATABASE_TRANSFER_CLEANUP_PENDING", JSON.stringify({ name, root }));
      const result = await lando(["destroy", "--purge", "--yes", "--format=json"]);
      console.log(
        "DATABASE_TRANSFER_CLEANUP_RESULT",
        JSON.stringify({ name, root, exitCode: result.exitCode, artifact: result.artifact }),
      );
      expect(result.exitCode, `Retained app/snapshots: ${name}; cwd: ${root}; ${result.artifact}`).toBe(0);
      expect(decodeInfoCliEnvelope(result.stdout).ok, result.artifact).toBe(true);
      await rm(root, { recursive: true, force: true });
      console.log("DATABASE_TRANSFER_CLEANED", JSON.stringify({ name, root }));
    },
  };
};

export const mssqlTransferLandofile = (
  fixture: Awaited<ReturnType<typeof databaseTransferFixture>>,
  version: "2019" | "2022",
) =>
  [
    `name: ${fixture.name}`,
    "runtime: 4",
    "provider: lando",
    "router:",
    "  enabled: false",
    "services:",
    "  database:",
    `    type: mssql:${version}`,
    "    home: false",
    "    appMount: false",
    "    creds:",
    "      user: sa",
    "      database: transfer_journey",
    `      password: \${secret:${fixture.secretId}}`,
    "  consumer:",
    "    type: compose",
    `    image: mcr.microsoft.com/mssql/server:${version}-latest`,
    "    home: false",
    "    appMount: false",
    "    command: [sleep, infinity]",
    "    environment:",
    '      SQLCMDUSER: "{{ services.database.creds.user }}"',
    '      SQLCMDPASSWORD: "{{ services.database.creds.password }}"',
    '      SQLCMDDBNAME: "{{ services.database.creds.database }}"',
    "tooling:",
    "  consumer-query:",
    "    service: consumer",
    "    cmd:",
    "      - sh",
    "      - -c",
    `      - 'exec /opt/mssql-tools18/bin/sqlcmd -S database,1433 -U "$SQLCMDUSER" -d "$SQLCMDDBNAME" -C -b -r1 -h -1 -W -Q "$1"'`,
    "      - consumer-query",
    "",
  ].join("\n");
