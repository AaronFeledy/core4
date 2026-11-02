import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { liveEnabled } from "./scanner-live-fixture.ts";

const cliEntry = resolve(import.meta.dir, "../../bin/lando.ts");
const childTimeout = 120_000;
const lando = async (cwd: string, args: readonly string[]) => {
  const binary = process.env.LANDO_SCENARIO_E2E_BINARY;
  const { BUN_BE_BUN: _bunBeBun, ...inherited } = process.env;
  const proc = Bun.spawn([...(binary === undefined ? [process.execPath, cliEntry] : [binary]), ...args], {
    cwd,
    env: { ...inherited, LANDO_TELEMETRY_ENABLED: "false" },
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
  return { exitCode, stdout, stderr };
};

test.skipIf(!liveEnabled)(
  "start applies changed container environment while preserving persistent volume data",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-config-drift-live-"));
    const name = `config-drift-${crypto.randomUUID().slice(0, 12)}`;
    const sentinel = "config-drift-persistent-data";
    // PID 1's environment cannot be replaced by exec-time overrides from the new plan.
    const containerEnv = "tr '\\000' '\\n' < /proc/1/environ | grep '^CONVERGE_VALUE='";
    const landofile = (value: "before" | "after") =>
      [
        `name: ${name}`,
        "runtime: 4",
        "provider: lando",
        "router:",
        "  enabled: false",
        "services:",
        "  web:",
        "    type: compose",
        "    image: docker.io/library/alpine:3.20",
        "    home: false",
        "    appMount: false",
        "    user: root",
        "    command:",
        "      - sleep",
        "      - infinity",
        "    storage:",
        "      - /data",
        "    environment:",
        `      CONVERGE_VALUE: ${value}`,
        "",
      ].join("\n");
    try {
      // Given a running app with data written to its persistent volume.
      await Bun.write(join(root, ".lando.yml"), landofile("before"));
      const started = await lando(root, ["start", "--format=json"]);
      expect(started.exitCode, started.stdout + started.stderr).toBe(0);
      const seeded = await lando(root, [
        "exec",
        "web",
        "--",
        "sh",
        "-c",
        `printf '%s\\n' '${sentinel}' > /data/sentinel && ${containerEnv}`,
      ]);
      expect(seeded.exitCode, seeded.stdout + seeded.stderr).toBe(0);
      expect(seeded.stdout.trim()).toBe("CONVERGE_VALUE=before");

      // When only the authored environment changes and the same app starts again.
      await Bun.write(join(root, ".lando.yml"), landofile("after"));
      const converged = await lando(root, ["start", "--format=json"]);
      expect(converged.exitCode, converged.stdout + converged.stderr).toBe(0);

      // Then the actual container has the new value and the original volume contents.
      const observed = await lando(root, [
        "exec",
        "web",
        "--",
        "sh",
        "-c",
        `${containerEnv} && cat /data/sentinel`,
      ]);
      expect(observed.exitCode, observed.stdout + observed.stderr).toBe(0);
      expect(observed.stdout.trim()).toBe(`CONVERGE_VALUE=after\n${sentinel}`);
    } finally {
      console.log("CONFIG_DRIFT_CLEANUP_PENDING", JSON.stringify({ name, root }));
      const destroyed = await lando(root, ["destroy", "--yes", "--volumes", "--format=json"]);
      console.log("CONFIG_DRIFT_CLEANUP", JSON.stringify({ name, root, ...destroyed }));
      expect(
        destroyed.exitCode,
        `Retained app ${name} at ${root}\n${destroyed.stdout}${destroyed.stderr}`,
      ).toBe(0);
      await rm(root, { recursive: true, force: true });
    }
  },
  5 * childTimeout + 60_000, // All five CLI calls, including teardown, plus filesystem/assertion overhead.
);
