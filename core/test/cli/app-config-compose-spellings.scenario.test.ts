import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-app-config-compose-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const runCli = async (args: ReadonlyArray<string>, cwd: string): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const parseEnvelope = <A>(stdout: string): A => {
  const envelope = JSON.parse(stdout) as { readonly ok?: boolean; readonly result?: unknown };
  expect(envelope.ok).toBe(true);
  return envelope.result as A;
};

const landofile = [
  "name: compose-spellings",
  "runtime: 4",
  "services:",
  "  web:",
  "    type: node:lts",
  "    working_dir: /app",
  "    depends_on:",
  "      database:",
  "        condition: service_healthy",
  "        restart: true",
  "    environment:",
  "      - NODE_ENV=development",
  "    labels:",
  "      - com.example.tier=web",
  "  database:",
  "    type: postgres",
  "",
].join("\n");

describe("lando config renders post-normalization Compose spellings", () => {
  test("config get services.web returns canonical resolved values", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), landofile);
      const result = await runCli(["app", "config", "get", "services.web", "--format", "json"], dir);
      expect(result.exitCode).toBe(0);
      const value = parseEnvelope<{ readonly value?: unknown }>(result.stdout).value as Record<
        string,
        unknown
      >;
      expect(value.workingDirectory).toBe("/app");
      expect(value.environment).toEqual({ NODE_ENV: "development" });
      expect(value.labels).toEqual({ "com.example.tier": "web" });
      expect(value.dependsOn).toEqual([{ service: "database", condition: "service_healthy", restart: true }]);
    });
  });

  test("config view renders the resolved Landofile without error", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), landofile);
      const result = await runCli(["app", "config", "--format", "json"], dir);
      expect(result.exitCode).toBe(0);
      const resolved = parseEnvelope<{ readonly app?: string }>(result.stdout);
      expect(resolved.app).toBe("compose-spellings");
    });
  });

  test("config view --format yaml renders post-normalization values", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), landofile);
      const result = await runCli(["app", "config", "view", "--format", "yaml"], dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("workingDirectory: /app");
      expect(result.stdout).toContain("NODE_ENV: development");
      expect(result.stdout).toContain("com.example.tier: web");
      expect(result.stdout).toContain("condition: service_healthy");
      expect(result.stdout).not.toContain("working_dir");
      expect(result.stdout).not.toContain("depends_on");
      expect(result.stdout).not.toContain("- NODE_ENV=development");
      expect(result.stdout).not.toContain("source: resolved");
      expect(result.stdout.startsWith("app:")).toBe(false);
    });
  });

  test("bare config --format yaml renders the resolved Landofile", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), landofile);
      const result = await runCli(["app", "config", "--format", "yaml"], dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("workingDirectory: /app");
      expect(result.stdout).toContain("NODE_ENV: development");
      expect(result.stdout).toContain("com.example.tier: web");
      expect(result.stdout).toContain("condition: service_healthy");
      expect(result.stdout).not.toContain("working_dir");
      expect(result.stdout).not.toContain("depends_on");
      expect(result.stdout).not.toContain("- NODE_ENV=development");
      expect(result.stdout).not.toContain("source: resolved");
      expect(result.stdout.startsWith("app:")).toBe(false);
      expect(result.stdout).not.toContain("services\t");
    });
  });

  test("config help documents yaml output", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), landofile);
      const result = await runCli(["app", "config", "--help"], dir);
      expect(result.stdout).toContain("--format Output format. (table, json, yaml)");
    });
  });

  test("bare config still renders the table by default", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), landofile);
      const result = await runCli(["app", "config"], dir);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("app\tcompose-spellings");
      expect(result.stdout).toMatch(/^services\t.+/m);
    });
  });
});
