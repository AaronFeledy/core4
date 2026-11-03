import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

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

const runLando = async (
  args: ReadonlyArray<string>,
  cwd: string,
  timeoutMs = 120_000,
): Promise<RunResult> => {
  const child = Bun.spawn([process.execPath, cli, ...args], {
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

const waitForFile = async (path: string, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const file = Bun.file(path);
    if (await file.exists()) return true;
    await Bun.sleep(500);
  }
  return false;
};

describe(`scheduled jobs live Docker${socket === undefined ? " (SKIP: explicit LANDO_TEST_DOCKER_SOCKET required)" : ""}`, () => {
  test.skipIf(socket === undefined)(
    "runs a job on the app mount as uid 1001, reaches db by service key, and shows sidecar logs",
    async () => {
      if (socket === undefined) throw new Error("LANDO_TEST_DOCKER_SOCKET required");
      const appRoot = await mkdtemp(join(tmpdir(), "lando-schedule-live-"));
      try {
        await writeFile(
          join(appRoot, ".lando.yml"),
          [
            "name: schedule-live",
            "services:",
            "  web:",
            "    type: compose",
            "    image: alpine:3.22",
            '    command: ["sleep", "infinity"]',
            '    user: "1001"',
            "    environment:",
            "      TZ: UTC",
            "    appMount: /app",
            "    dependsOn:",
            "      - db",
            "    schedule:",
            "      - name: tick",
            '        every: "@every 1s"',
            '        run: "touch /app/scheduled.txt && echo scheduled-job-ran && getent hosts db > /app/db-hosts.txt"',
            "  db:",
            "    type: compose",
            "    image: alpine:3.22",
            '    command: ["sleep", "infinity"]',
            "    appMount: false",
            "",
          ].join("\n"),
        );
        await chmod(appRoot, 0o777);

        const start = await runLando(["start", "--yes"], appRoot, 600_000);
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

        const dbHosts = await Bun.file(join(appRoot, "db-hosts.txt")).text();
        expect(dbHosts).toMatch(/\bdb\b/u);

        const logs = await runLando(["logs", "--service=web-schedule", "--format=json"], appRoot);
        expect(logs.exitCode, `${logs.stdout}\n${logs.stderr}`).toBe(0);
        expect(logs.stdout).toContain("scheduled-job-ran");
      } finally {
        await runLando(["destroy", "-y"], appRoot, 180_000);
        await rm(appRoot, { recursive: true, force: true });
      }
    },
    700_000,
  );
});
