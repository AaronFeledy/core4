import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import { liveEnabled } from "./scanner-live-fixture.ts";

const cliEntry = resolve(import.meta.dir, "../../bin/lando.ts");
const childTimeout = 240_000;

test.skipIf(!liveEnabled)(
  "PostgreSQL secret credentials support TCP tooling and export after a store-unavailable selected restart",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-secret-postgres-live-"));
    const name = `secret-pg-${crypto.randomUUID().slice(0, 12)}`;
    const secretId = `LIVE_PG_${crypto.randomUUID().replaceAll("-", "_")}`;
    const password = `live-pg-${crypto.randomUUID()}`;
    const wrongPassword = `wrong-pg-${crypto.randomUUID()}`;
    const paths = makeLandoPaths();
    let invocation = 0;
    const lando = async (args: readonly string[], credential: string | undefined) => {
      const binary = process.env.LANDO_SCENARIO_E2E_BINARY;
      const { BUN_BE_BUN: _bunBeBun, ...inherited } = process.env;
      const proc = Bun.spawn([...(binary === undefined ? [process.execPath, cliEntry] : [binary]), ...args], {
        cwd: root,
        env: {
          ...inherited,
          LANDO_TELEMETRY_ENABLED: "false",
          [`LANDO_SECRET_${secretId}`]: credential,
        },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        timeout: childTimeout,
        killSignal: "SIGKILL",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ]);
      const output = stdout + stderr;
      const artifact = join(root, `cli-${++invocation}.json`);
      // Retain diagnostics without ever persisting an accidentally disclosed credential.
      await Bun.write(
        artifact,
        JSON.stringify({ args, exitCode, stdout, stderr })
          .replaceAll(password, "[redacted]")
          .replaceAll(wrongPassword, "[redacted]"),
      );
      expect(output.includes(password), `Credential disclosed; sanitized diagnostics: ${artifact}`).toBe(
        false,
      );
      expect(output.includes(wrongPassword), `Credential disclosed; sanitized diagnostics: ${artifact}`).toBe(
        false,
      );
      return { exitCode, stdout, stderr, artifact };
    };
    const query = ["psql", "--", "-h", "127.0.0.1", "-w", "-tAc"] as const;
    try {
      // Given a unique persistent database whose only authored password is a secret reference.
      await Bun.write(
        join(root, ".lando.yml"),
        [
          `name: ${name}`,
          "runtime: 4",
          "provider: lando",
          "router:",
          "  enabled: false",
          "services:",
          "  db:",
          "    type: postgres:17",
          "    home: false",
          "    appMount: false",
          "    creds:",
          "      user: lando",
          "      database: credential_journey",
          `      password: \${secret:${secretId}}`,
          "    environment:",
          "      PGHOST: 127.0.0.1",
          "      POSTGRES_INITDB_ARGS: --auth-host=scram-sha-256",
          "",
        ].join("\n"),
      );
      const started = await lando(["start", "--format=json"], password);
      expect(started.exitCode, started.stdout + started.stderr).toBe(0);
      const connected = await lando([...query, "SELECT current_user"], password);
      expect(connected.exitCode, connected.stdout + connected.stderr).toBe(0);
      expect(connected.stdout.trim()).toBe("lando");
      const seeded = await lando(
        [
          ...query,
          "CREATE TABLE credential_probe (value text); INSERT INTO credential_probe VALUES ('retained');",
        ],
        password,
      );
      expect(seeded.exitCode, seeded.stdout + seeded.stderr).toBe(0);
      const exported = await lando(
        ["db:export", "dump.sql", "--service=db", "--yes", "--format=json"],
        password,
      );
      expect(exported.exitCode, exported.stdout + exported.stderr).toBe(0);
      const dump = await readFile(join(root, "dump.sql"), "utf8");
      expect(dump.length).toBeGreaterThan(0);
      expect(dump).toContain("PostgreSQL database dump");
      expect(dump).toContain("credential_probe");
      expect(dump).toContain("retained");
      const rejected = await lando([...query, "SELECT current_user"], wrongPassword);
      expect(rejected.exitCode, `Wrong password accepted; ${rejected.artifact}`).not.toBe(0);
      expect(rejected.stdout + rejected.stderr).toMatch(/password authentication failed/i);

      // When the selected existing service restarts with its secret absent from the env store,
      // creation would fail closed. Success exercises reuse without an unreliable identity probe.
      const restarted = await lando(["restart", "--service=db", "--format=json"], undefined);
      expect(restarted.exitCode, restarted.stdout + restarted.stderr).toBe(0);

      // Then generated TCP tooling still authenticates and the original volume data survives.
      const observed = await lando([...query, "SELECT value FROM credential_probe"], password);
      expect(observed.exitCode, observed.stdout + observed.stderr).toBe(0);
      expect(observed.stdout.trim()).toBe("retained");
      const logs = await lando(["logs", "--service=db", "--format=json"], password);
      expect(logs.exitCode, logs.stdout + logs.stderr).toBe(0);
      // Scope disk inspection to our own app/cache, never the parent's shared state database.
      const cacheDir = paths.appCacheDir(name, root);
      expect((await readFile(paths.appPlanCacheFile(name, root))).byteLength).toBeGreaterThan(0);
      for (const directory of [root, cacheDir]) {
        const entries = await readdir(directory, { recursive: true, withFileTypes: true });
        for (const entry of entries.filter((candidate) => candidate.isFile())) {
          const file = join(entry.parentPath, entry.name);
          const bytes = await readFile(file);
          expect(bytes.includes(Buffer.from(password)), `Credential in ${file}`).toBe(false);
          expect(bytes.includes(Buffer.from(wrongPassword)), `Credential in ${file}`).toBe(false);
        }
      }
    } finally {
      console.log("SECRET_POSTGRES_CLEANUP_PENDING", JSON.stringify({ name, root }));
      const destroyed = await lando(["destroy", "--yes", "--volumes", "--format=json"], password);
      expect(
        destroyed.exitCode,
        `Retained app ${name} at ${root}; diagnostics: ${destroyed.artifact}\n${destroyed.stdout}${destroyed.stderr}`,
      ).toBe(0);
      await rm(root, { recursive: true, force: true });
    }
  },
  10 * childTimeout + 60_000, // Nine journey calls plus app-only teardown; Bun does not cancel timed-out tests.
);
