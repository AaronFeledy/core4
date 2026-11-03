import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const socket = process.env.LANDO_TEST_DOCKER_SOCKET;
const repoRoot = resolve(import.meta.dirname, "../../..");
const cli = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const dockerEnv = (): NodeJS.ProcessEnv => {
  if (socket === undefined) return process.env;
  const host = socket.startsWith("/") ? `unix://${socket}` : socket;
  return { ...process.env, DOCKER_HOST: host, LANDO_PROVIDER: "docker" };
};

const run = async (argv: ReadonlyArray<string>, cwd: string, timeoutMs = 120_000): Promise<RunResult> => {
  const child = Bun.spawn([...argv], {
    cwd,
    env: dockerEnv(),
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const runLando = (args: ReadonlyArray<string>, cwd: string, timeoutMs = 120_000) =>
  run([process.execPath, cli, ...args], cwd, timeoutMs);

const waitForFile = async (path: string, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const file = Bun.file(path);
    if (await file.exists()) return true;
    await Bun.sleep(500);
  }
  return false;
};

const landofile = (name: string, image: string, withSchedule: boolean): string =>
  [
    `name: ${name}`,
    "services:",
    "  web:",
    "    type: compose",
    `    image: ${image}`,
    '    command: ["sleep", "infinity"]',
    '    user: "1001"',
    "    environment:",
    "      TZ: UTC",
    "    appMount: /app",
    "    dependsOn:",
    "      - db",
    ...(withSchedule
      ? [
          "    schedule:",
          "      - name: tick",
          '        every: "@every 1s"',
          '        run: "touch /app/scheduled.txt && echo scheduled-job-ran && getent hosts db > /app/db-hosts.txt"',
          "      - name: other",
          '        every: "@every 1s"',
          '        user: "1002"',
          '        run: "touch /app/other.txt && id -u > /app/other-uid.txt"',
          "      - name: now",
          '        every: "@yearly"',
          '        run: "touch /app/manual.txt && echo ran-in-parent"',
        ]
      : []),
    "  db:",
    "    type: compose",
    `    image: ${image}`,
    '    command: ["sleep", "infinity"]',
    "    appMount: false",
    "",
  ].join("\n");

const scheduleContainers = async (appName: string, appRoot: string): Promise<string[]> => {
  const listed = await run(["docker", "ps", "-a", "--format", "{{.Names}}"], appRoot);
  expect(listed.exitCode, `${listed.stdout}\n${listed.stderr}`).toBe(0);
  const project = basename(appRoot).toLowerCase();
  return listed.stdout
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name.includes("web-schedule"))
    .filter((name) => name.includes(appName) || name.toLowerCase().includes(project));
};

describe(`scheduled jobs live Docker${socket === undefined ? " (SKIP: explicit LANDO_TEST_DOCKER_SOCKET required)" : ""}`, () => {
  for (const image of ["alpine:3.22", "php:8.3"] as const) {
    test.skipIf(socket === undefined)(
      `runs jobs as parent and other users, schedule:run in parent, and removes the sidecar on rebuild (${image})`,
      async () => {
        if (socket === undefined) throw new Error("LANDO_TEST_DOCKER_SOCKET required");
        const appRoot = await mkdtemp(join(tmpdir(), "lando-schedule-live-"));
        const appName = `sched${crypto.randomUUID().replace(/-/gu, "").slice(0, 10)}`;
        try {
          await writeFile(join(appRoot, ".lando.yml"), landofile(appName, image, true));
          await chmod(appRoot, 0o777);

          const start = await runLando(["start"], appRoot, 600_000);
          expect(start.exitCode, `${start.stdout}\n${start.stderr}`).toBe(0);

          const scheduled = join(appRoot, "scheduled.txt");
          const reached = await waitForFile(scheduled, 60_000);
          expect(reached, "scheduled job did not write /app/scheduled.txt").toBe(true);

          const owner = await runLando(
            ["exec", "--user", "1001", "web", "--", "stat", "-c", "%u %A", "/app/scheduled.txt"],
            appRoot,
          );
          expect(owner.exitCode, `${owner.stdout}\n${owner.stderr}`).toBe(0);
          expect(owner.stdout).toMatch(/^1001 /u);

          const writable = await runLando(
            ["exec", "--user", "1001", "web", "--", "sh", "-c", "echo more >> /app/scheduled.txt"],
            appRoot,
          );
          expect(writable.exitCode, `${writable.stdout}\n${writable.stderr}`).toBe(0);

          const otherUid = join(appRoot, "other-uid.txt");
          expect(await waitForFile(otherUid, 60_000), "job user 1002 did not write /app/other-uid.txt").toBe(
            true,
          );
          expect((await Bun.file(otherUid).text()).trim()).toBe("1002");
          const otherOwner = await runLando(
            ["exec", "--user", "1001", "web", "--", "stat", "-c", "%u", "/app/other.txt"],
            appRoot,
          );
          expect(otherOwner.exitCode, `${otherOwner.stdout}\n${otherOwner.stderr}`).toBe(0);
          expect(otherOwner.stdout.trim()).toBe("1002");

          const dbHosts = await Bun.file(join(appRoot, "db-hosts.txt")).text();
          expect(dbHosts).toMatch(/\bdb\b/u);

          const logs = await runLando(["logs", "--service=web-schedule", "--format=json"], appRoot);
          expect(logs.exitCode, `${logs.stdout}\n${logs.stderr}`).toBe(0);
          expect(logs.stdout).toContain("scheduled-job-ran");

          const manual = await runLando(["schedule:run", "now", "--format=json"], appRoot);
          expect(manual.exitCode, `${manual.stdout}\n${manual.stderr}`).toBe(0);
          expect(await waitForFile(join(appRoot, "manual.txt"), 10_000)).toBe(true);

          await writeFile(join(appRoot, ".lando.yml"), landofile(appName, image, false));
          const rebuild = await runLando(["rebuild", "-y"], appRoot, 600_000);
          expect(rebuild.exitCode, `${rebuild.stdout}\n${rebuild.stderr}`).toBe(0);
          expect(await scheduleContainers(appName, appRoot)).toEqual([]);
        } finally {
          await runLando(["destroy", "-y", "--volumes"], appRoot, 180_000);
          await rm(appRoot, { recursive: true, force: true });
        }
      },
      900_000,
    );
  }
});
