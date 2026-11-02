import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { liveEnabled } from "./scanner-live-fixture.ts";

const cliEntry = resolve(import.meta.dir, "../../bin/lando.ts");
const lando = async (cwd: string, args: readonly string[]) => {
  const binary = process.env.LANDO_SCENARIO_E2E_BINARY;
  const { BUN_BE_BUN: _bunBeBun, ...inherited } = process.env;
  const proc = Bun.spawn([...(binary === undefined ? [process.execPath, cliEntry] : [binary]), ...args], {
    cwd,
    env: { ...(binary === undefined ? process.env : inherited), LANDO_TELEMETRY_ENABLED: "false" },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

test.skipIf(!liveEnabled)(
  "a failed apply leaves its postgres volume seedable after retry",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-volume-receipts-live-"));
    const name = `receipts-${crypto.randomUUID().slice(0, 12)}`;
    const landofile = (fault: boolean) =>
      [
        `name: ${name}`,
        "runtime: 4",
        "provider: lando",
        "router:",
        "  enabled: false",
        "services:",
        "  database:",
        "    type: postgres:16",
        "  web:",
        "    type: compose",
        "    image: docker.io/library/alpine:3.20",
        "    home: false",
        "    appMount: false",
        "    user: root",
        ...(fault
          ? ["    entrypoint:", "      - /lando-receipt-test-missing-executable"]
          : ["    command:", "      - sleep", "      - infinity"]),
        "",
      ].join("\n");
    try {
      await Bun.write(join(root, ".lando.yml"), landofile(true));
      await Bun.write(
        join(root, "seed.sql"),
        "CREATE TABLE receipt_probe (id integer); INSERT INTO receipt_probe VALUES (1);\n",
      );
      const failed = await lando(root, ["start", "--format=json"]);
      expect(failed.exitCode, failed.stdout + failed.stderr).toBe(1);
      expect(failed.stdout + failed.stderr).toContain("ServiceStartError");
      await Bun.write(join(root, ".lando.yml"), landofile(false));
      const started = await lando(root, ["start", "--format=json"]);
      expect(started.exitCode, started.stdout + started.stderr).toBe(0);
      const seeded = await lando(root, ["db:seed", "seed.sql", "--format=json"]);
      expect(seeded.exitCode, seeded.stdout + seeded.stderr).toBe(0);
      const queried = await lando(root, ["psql", "-tAc", "SELECT count(*) FROM receipt_probe;"]);
      expect(queried.exitCode, queried.stdout + queried.stderr).toBe(0);
      expect(queried.stdout.trim()).toBe("1");
    } finally {
      const destroyed = await lando(root, ["destroy", "--yes", "--volumes", "--format=json"]);
      await rm(root, { recursive: true, force: true });
      expect(destroyed.exitCode, destroyed.stdout + destroyed.stderr).toBe(0);
    }
  },
  600_000,
);
