import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { runFixtureCli } from "./convergence-cli.ts";

const cliEntry = resolve(import.meta.dir, "../../bin/lando.ts");
const journeyTimeout = 10 * 120_000;

const providers = [
  {
    id: "docker",
    socketPath:
      process.env.LANDO_TEST_DOCKER_SOCKET === "/var/run/docker.sock" ? "/var/run/docker.sock" : undefined,
  },
  { id: "podman", socketPath: resolveLiveProviderSocket()?.socketPath },
] as const;

const envelopeFrom = (stdout: string): typeof CommandResultEnvelope.Type => {
  const parsed = JSON.parse(stdout.trim().split("\n").at(-1) ?? "") as unknown;
  if (typeof parsed === "object" && parsed !== null && "_tag" in parsed && parsed._tag === "result") {
    return Schema.decodeUnknownSync(CommandResultEnvelope)(Reflect.get(parsed, "envelope"));
  }
  return Schema.decodeUnknownSync(CommandResultEnvelope)(parsed);
};

// PostgreSQL images trust loopback connections, so its case proves the check still sees the
// password rule that other containers meet; Lando's own loopback client keeps working there.
const databases = [
  {
    type: "mariadb:11.4",
    family: "mariadb",
    label: "MariaDB",
    client: ["mariadb", "-N", "-B", "-e", "SELECT 1"],
  },
  { type: "postgres:16", family: "postgres", label: "PostgreSQL", client: undefined },
] as const;

const landofile = (name: string, type: string, password: string) =>
  [
    `name: ${name}`,
    "runtime: 4",
    "agentEnv: false",
    "sshAgent:",
    "  sidecar: false",
    "gpgAgent:",
    "  forward: false",
    "router:",
    "  enabled: false",
    "services:",
    "  db:",
    `    type: ${type}`,
    "    home: false",
    "    appMount: false",
    "    creds:",
    `      password: ${password}`,
    "",
  ].join("\n");

const doctorWarning = (stdout: string) => {
  const envelope = envelopeFrom(stdout);
  const result = envelope.result as {
    readonly checks?: ReadonlyArray<{
      readonly section: string;
      readonly name: string;
      readonly status: string;
      readonly context?: Readonly<Record<string, string>>;
    }>;
  };
  return result.checks?.find((check) => check.section === "database-credentials" && check.status === "warn");
};

for (const provider of providers)
  for (const database of databases) {
    test.skipIf(provider.socketPath === undefined)(
      `${database.label} observes a changed password on the ${provider.id} provider`,
      async () => {
        if (provider.socketPath === undefined) throw new Error(`A live ${provider.id} socket is required.`);
        const directory = await mkdtemp(join(tmpdir(), `lando-db-creds-${provider.id}-`));
        const root = join(directory, "app");
        const name = `db-creds-${provider.id}-${crypto.randomUUID().slice(0, 8)}`;
        const original = `Original!9-${crypto.randomUUID()}`;
        const changed = `Changed!9-${crypto.randomUUID()}`;
        const env = {
          ...process.env,
          LANDO_USER_CONF_ROOT: join(directory, "config"),
          LANDO_USER_DATA_ROOT: join(directory, "data"),
          LANDO_USER_CACHE_ROOT: join(directory, "cache"),
          LANDO_SYSTEM_PLUGIN_ROOT: join(directory, "system-plugins"),
          LANDO_PROVIDER: provider.id,
          LANDO_CONFIG__default_provider_id: provider.id,
          DOCKER_HOST: `unix://${provider.socketPath}`,
          LANDO_TELEMETRY_ENABLED: "false",
        };
        const lando = (args: readonly string[]) =>
          Effect.runPromise(
            runFixtureCli(
              [
                ...(process.env.LANDO_SCENARIO_E2E_BINARY === undefined
                  ? [process.execPath, cliEntry]
                  : [process.env.LANDO_SCENARIO_E2E_BINARY]),
                ...args,
              ],
              root,
              env,
            ),
          );
        const artifact = async (label: string, value: unknown) => {
          const path = join(directory, `${label}.json`);
          await Bun.write(path, JSON.stringify(value));
          return path;
        };
        try {
          await Bun.write(join(directory, "placeholder"), "");
          await rm(join(directory, "placeholder"));
          await Bun.write(join(root, ".lando.yml"), landofile(name, database.type, original));
          const started = await lando(["start", "--format=json"]);
          expect(started.exitCode, await artifact("start", started)).toBe(0);
          expect(envelopeFrom(started.stdout).ok).toBe(true);
          if (database.client !== undefined) {
            const query = await lando(database.client);
            expect(query.exitCode, await artifact("query-before", query)).toBe(0);
          }

          // When the author changes the password on an initialized volume.
          await Bun.write(join(root, ".lando.yml"), landofile(name, database.type, changed));
          const restarted = await lando(["restart", "--format=json"]);
          expect(restarted.exitCode, await artifact("restart", restarted)).toBe(0);
          const envelope = envelopeFrom(restarted.stdout);
          expect(envelope.ok, await artifact("restart-envelope", envelope)).toBe(true);
          const warning = envelope.warnings.find(
            (entry) => entry.code === "LANDO_DATABASE_CREDENTIALS_REJECTED",
          );
          expect(warning, await artifact("warnings", envelope.warnings)).toMatchObject({
            context: { service: "db", family: database.family, login: "app", changedMembers: "password" },
          });
          expect(JSON.stringify(warning)).not.toContain(changed);
          expect(JSON.stringify(warning)).not.toContain(original);

          // The warning describes the same failure the next client command hits.
          if (database.client !== undefined) {
            const denied = await lando(database.client);
            expect(denied.exitCode, await artifact("query-denied", denied)).not.toBe(0);
            expect(denied.stderr).toContain("Access denied");
          }

          // Doctor reaches the same verdict against the running applied plan.
          const doctor = await lando(["doctor", "--app", "--format=json"]);
          expect(doctor.exitCode, await artifact("doctor-doctor", doctor)).toBe(0);
          expect(doctorWarning(doctor.stdout), await artifact("doctor-output", doctor.stdout)).toMatchObject({
            name: "database-credentials",
            context: { service: "db", family: database.family, login: "app" },
          });
        } finally {
          const destroyed = await lando(["destroy", "-y", "--volumes", "--format=json"]).catch(
            () => undefined,
          );
          if (destroyed !== undefined) await artifact("destroy", destroyed);
          await rm(directory, { recursive: true, force: true });
        }
      },
      journeyTimeout,
    );
  }
