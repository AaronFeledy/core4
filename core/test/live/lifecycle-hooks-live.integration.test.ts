import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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

const hookEvents = [
  "pre-init",
  "post-init",
  "pre-start",
  "post-start",
  "pre-stop",
  "post-stop",
  "pre-restart",
  "post-restart",
  "pre-rebuild",
  "post-rebuild",
] as const;
const init = ["pre-init", "post-init"];
const stopAndStart = ["pre-stop", "post-stop", "pre-start", "post-start"];

test.skipIf(!liveEnabled)(
  "start, restart, and rebuild run Landofile hooks in order and recreate only what they should",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-lifecycle-hooks-live-"));
    const name = `hooks-${crypto.randomUUID().slice(0, 12)}`;
    const hookLog = join(root, "hooks.log");
    const service = (id: string) => [
      `  ${id}:`,
      "    type: compose",
      "    image: docker.io/library/alpine:3.20",
      "    home: false",
      "    appMount: false",
      "    user: root",
      // PID 1 ignores SIGTERM unless it traps it; without the trap every stop waits out the grace period.
      "    command:",
      "      - sh",
      "      - -c",
      "      - \"trap 'exit 0' TERM; sleep infinity & wait\"",
    ];
    const landofile = [
      `name: ${name}`,
      "runtime: 4",
      "provider: lando",
      "router:",
      "  enabled: false",
      "services:",
      ...service("web"),
      ...service("cache"),
      "events:",
      ...hookEvents.flatMap((event) => [
        `  ${event}:`,
        `    - cmd: echo ${event} >> ${hookLog}`,
        '      service: ":host"',
      ]),
      "",
    ].join("\n");
    const hooksOf = async (args: readonly string[]) => {
      await writeFile(hookLog, "");
      const result = await lando(root, [...args, "--format=json"]);
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      return (await readFile(hookLog, "utf8")).split("\n").filter((line) => line.length > 0);
    };
    // A marker in a container's writable layer survives only while that container does.
    const mark = async (id: string) => {
      const marked = await lando(root, ["exec", id, "--", "touch", "/tmp/kept"]);
      expect(marked.exitCode, marked.stdout + marked.stderr).toBe(0);
    };
    const kept = async (id: string) =>
      (await lando(root, ["exec", id, "--", "test", "-e", "/tmp/kept"])).exitCode === 0;
    try {
      await writeFile(join(root, ".lando.yml"), landofile);

      expect(await hooksOf(["start"])).toEqual([...init, "pre-start", "post-start"]);
      await mark("web");
      await mark("cache");

      expect(await hooksOf(["restart"])).toEqual([...init, "pre-restart", ...stopAndStart, "post-restart"]);
      expect([await kept("web"), await kept("cache")]).toEqual([false, false]);
      await mark("web");
      await mark("cache");

      expect(await hooksOf(["restart", "--service", "web"])).toEqual([
        ...init,
        "pre-restart",
        "post-restart",
      ]);
      expect([await kept("web"), await kept("cache")]).toEqual([true, true]);

      expect(await hooksOf(["rebuild", "--yes"])).toEqual([
        ...init,
        "pre-rebuild",
        ...stopAndStart,
        "post-rebuild",
      ]);
      expect([await kept("web"), await kept("cache")]).toEqual([false, false]);
      await mark("web");
      await mark("cache");

      expect(await hooksOf(["rebuild", "--service", "cache", "--yes"])).toEqual([
        ...init,
        "pre-rebuild",
        "post-rebuild",
      ]);
      expect([await kept("web"), await kept("cache")]).toEqual([true, false]);
    } finally {
      console.log("LIFECYCLE_HOOKS_CLEANUP_PENDING", JSON.stringify({ name, root }));
      const destroyed = await lando(root, ["destroy", "--yes", "--volumes", "--format=json"]);
      console.log("LIFECYCLE_HOOKS_CLEANUP", JSON.stringify({ name, root, ...destroyed }));
      expect(
        destroyed.exitCode,
        `Retained app ${name} at ${root}\n${destroyed.stdout}${destroyed.stderr}`,
      ).toBe(0);
      await rm(root, { recursive: true, force: true });
    }
  },
  // Five lifecycle commands, eighteen short execs, and teardown.
  12 * childTimeout,
);
