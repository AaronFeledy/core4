import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { Schema } from "effect";
import { decodeInfoCliEnvelope } from "./convergence-cli.ts";
import { databaseJourneyTimeout, databaseTransferFixture } from "./database-transfer-fixture.ts";
import { liveEnabled } from "./scanner-live-fixture.ts";

const cliEntry = resolve(import.meta.dir, "../../bin/lando.ts");
const incomplete = Schema.Struct({
  _tag: Schema.Literal("SqlDumpIncompleteError"),
  reason: Schema.Literal("truncated"),
  recoverySnapshotId: Schema.optionalKey(Schema.String),
});

// The fixture's runner captures text and fails on any credential in output. Dash dumps are
// byte payloads that legitimately carry row data, so they are spawned directly.
const landoArgv = (): string[] => {
  const binary = process.env.LANDO_SCENARIO_E2E_BINARY;
  return binary === undefined ? [process.execPath, cliEntry] : [binary];
};

test.skipIf(!liveEnabled)(
  "PostgreSQL dumps stream through stdout and stdin byte-exact, and truncated stdin is refused",
  async () => {
    const fixture = await databaseTransferFixture("pg-dump-stdio");
    const { root, name, secretId, password, marker, lando } = fixture;
    const { BUN_BE_BUN: _bunBeBun, ...inherited } = process.env;
    const env = { ...inherited, LANDO_TELEMETRY_ENABLED: "false", [`LANDO_SECRET_${secretId}`]: password };
    const dash = async (args: readonly string[], stdin?: Uint8Array) => {
      const child = Bun.spawn([...landoArgv(), ...args], {
        cwd: root,
        env,
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
        stdout: "pipe",
        stderr: "pipe",
        timeout: 120_000,
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).bytes(),
        new Response(child.stderr).text(),
      ]);
      return { exitCode, stdout, stderr };
    };
    const query = ["psql", "--", "-h", "127.0.0.1", "-w", "-tAc"] as const;
    try {
      // Given a database whose rows include the runtime-resolved password as plain data.
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
          "",
        ].join("\n"),
      );
      const started = await lando(["start", "--format=json"]);
      expect(started.exitCode, started.artifact).toBe(0);
      const seeded = await lando([
        ...query,
        // The bulk table makes the dump far larger than a pipe buffer, so early close and stalls bite mid-dump.
        `CREATE TABLE stdio_probe (marker text, payload text); INSERT INTO stdio_probe VALUES ('${marker}', '${password}'); CREATE TABLE stdio_bulk AS SELECT g, repeat('x', 200) AS pad FROM generate_series(1, 50000) g;`,
      ]);
      expect(seeded.exitCode, seeded.artifact).toBe(0);

      // When the dump streams to stdout, uncompressed and compressed.
      const plain = await dash(["db:export", "-", "--service=database"]);
      expect(plain.exitCode, plain.stderr).toBe(0);
      const text = new TextDecoder().decode(plain.stdout);
      // Then stdout is the dump alone, byte-exact: no narration and no redaction of row data.
      expect(text.startsWith("--\n-- PostgreSQL database dump")).toBe(true);
      expect(text.includes("-- PostgreSQL database dump complete")).toBe(true);
      expect(text.includes(password)).toBe(true);
      expect(text.includes("[redacted]")).toBe(false);
      const gzipped = await dash(["db:export", "-", "--service=database", "--compression=gzip"]);
      expect(gzipped.exitCode, gzipped.stderr).toBe(0);
      expect([...gzipped.stdout.subarray(0, 2)]).toEqual([0x1f, 0x8b]);
      expect(new TextDecoder().decode(Bun.gunzipSync(new Uint8Array(gzipped.stdout))).includes(marker)).toBe(
        true,
      );

      // When the gzip dump comes back on stdin after the data changed.
      const changed = await lando([...query, "UPDATE stdio_probe SET marker = 'changed'"]);
      expect(changed.exitCode, changed.artifact).toBe(0);
      const imported = await dash(["db:import", "-", "--service=database", "--yes"], gzipped.stdout);
      expect(imported.exitCode, imported.stderr).toBe(0);
      const restored = await lando([...query, "SELECT marker FROM stdio_probe"]);
      expect(restored.stdout.trim() === marker, restored.artifact).toBe(true);

      // When a dump cut off before pg_dump's completion trailer arrives on stdin.
      const before = await lando([...query, "UPDATE stdio_probe SET marker = 'before-cut'"]);
      expect(before.exitCode, before.artifact).toBe(0);
      const cut = plain.stdout.subarray(0, text.indexOf("-- PostgreSQL database dump complete"));
      const refused = await dash(["db:import", "-", "--service=database", "--yes", "--format=json"], cut);
      // Then it is refused before a recovery snapshot, and the data is untouched.
      expect(refused.exitCode, refused.stderr).toBe(1);
      const envelope = decodeInfoCliEnvelope(new TextDecoder().decode(refused.stdout));
      const failure = Schema.decodeUnknownSync(incomplete)(envelope.error);
      expect(failure.recoverySnapshotId).toBeUndefined();
      const untouched = await lando([...query, "SELECT marker FROM stdio_probe"]);
      expect(untouched.stdout.trim(), untouched.artifact).toBe("before-cut");

      // When the reader closes early, the export stops with the SIGPIPE convention.
      const pipeline = Bun.spawn(
        [
          "bash",
          "-c",
          'set -o pipefail; "$@" db:export - --service=database 2>/dev/null | head -c 64 >/dev/null',
          "bash",
          ...landoArgv(),
        ],
        { cwd: root, env, stdout: "ignore", stderr: "pipe", timeout: 120_000 },
      );
      expect(await pipeline.exited).toBe(141);

      // When the reader stalls mid-dump and the user interrupts, the export exits 130 and stops pg_dump.
      const stalled = Bun.spawn(
        [
          "bash",
          "-c",
          [
            "set -m",
            'fifo="$1"; shift',
            'mkfifo "$fifo"',
            '"$@" db:export - --service=database > "$fifo" 2>/dev/null &',
            "writer=$!",
            'exec 3<"$fifo"',
            // Wait for the first dump byte, then keep fd 3 open and unread so the dump cannot finish.
            "head -c 1 <&3 >/dev/null",
            'kill -INT "$writer"',
            'wait "$writer"; echo "exit=$?"',
          ].join("\n"),
          "bash",
          join(root, "stall.fifo"),
          ...landoArgv(),
        ],
        { cwd: root, env, stdout: "pipe", stderr: "pipe", timeout: 120_000 },
      );
      const [stalledOut] = await Promise.all([new Response(stalled.stdout).text(), stalled.exited]);
      expect(stalledOut.trim()).toBe("exit=130");
      const processes = await lando([
        "exec",
        "database",
        "--",
        "sh",
        "-c",
        'for p in /proc/[0-9]*; do tr "\\0" " " < "$p/cmdline"; echo; done 2>/dev/null',
      ]);
      expect(processes.exitCode, processes.artifact).toBe(0);
      expect(processes.stdout.includes("pg_dump"), processes.artifact).toBe(false);
    } finally {
      await fixture.cleanup();
    }
  },
  databaseJourneyTimeout,
);
