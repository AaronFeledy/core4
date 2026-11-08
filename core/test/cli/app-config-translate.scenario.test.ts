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
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-config-translate-scenario-")));
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
    env: {
      ...process.env,
      LANDO_USER_CONF_ROOT: join(cwd, "conf"),
      LANDO_USER_CACHE_ROOT: join(cwd, "cache"),
      LANDO_USER_DATA_ROOT: join(cwd, "data"),
      LANDO_SYSTEM_PLUGIN_ROOT: join(cwd, "plugins"),
    },
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

describe("lando app:config:translate CLI argv parsing", () => {
  test.each(["text", "json", "yaml"] as const)(
    "refuses blocked writes with unchanged files and a tagged %s error",
    async (format) => {
      // Given: conflicting server ports that cannot be translated safely.
      await withTempCwd(async (dir) => {
        const original =
          "name: demo\nservices:\n  database:\n    type: mysql:8.0\n    port: 3308\n    overrides:\n      environment:\n        MYSQL_TCP_PORT: '3307'\n";
        await writeFile(join(dir, ".lando.yml"), original);
        // When: requesting a write through the source CLI.
        const result = await runCli(
          ["app:config:translate", "--from=lando3", "--write", `--format=${format}`],
          dir,
        );
        // Then: the tagged failure exits 1 without modifying the source.
        expect(result.exitCode).toBe(1);
        expect(await Bun.file(join(dir, ".lando.yml")).text()).toBe(original);
        if (format === "text") {
          expect(result.stderr).toContain("# 1 unsupported (blocks --write)");
          expect(result.stderr).toContain("[unsupported]");
          expect(result.stderr).toContain(
            ".lando.yml:services.database.overrides.environment.MYSQL_TCP_PORT",
          );
          expect(result.stderr).toContain("#   Next:");
          expect(result.stderr).toContain("code: ConfigTranslateError");
        } else {
          const envelope = format === "json" ? JSON.parse(result.stdout) : Bun.YAML.parse(result.stdout);
          expect(envelope.ok).toBe(false);
          expect(envelope.error._tag).toBe("ConfigTranslateError");
          expect(Object.keys(envelope.error).sort()).toEqual([
            "_tag",
            "diagnostics",
            "message",
            "remediation",
          ]);
          expect(envelope.error.diagnostics).toContainEqual(
            expect.objectContaining({
              kind: "unsupported",
              sourceId: ".lando.yml",
              keyPath: ["services", "database", "overrides", "environment", "MYSQL_TCP_PORT"],
            }),
          );
          expect(result.stderr).not.toContain("# ");
        }
      });
    },
  );
  test.each(["json", "yaml"] as const)(
    "preserves identical ordered redacted diagnostics for preview and blocked %s writes",
    async (format) => {
      // Given
      await withTempCwd(async (dir) => {
        const original =
          'name: demo\nservices: {db: {type: postgres:17, port: bad, environment: {PGPORT: "token=SECRET123"}, moreHttpPorts: [8080]}}\n';
        await writeFile(join(dir, ".lando.yml"), original);
        const args = ["app:config:translate", "--from=lando3", `--format=${format}`];
        // When
        const preview = await runCli(["app:config:translate", "--from=lando3", "--format=json"], dir);
        const blocked = await runCli([...args, "--write"], dir);
        // Then
        expect(preview.exitCode).toBe(0);
        expect(blocked.exitCode).toBe(1);
        const previewEnvelope = JSON.parse(
          format === "json" ? preview.stdout : JSON.stringify(Bun.YAML.parse(preview.stdout)),
        );
        const blockedEnvelope = JSON.parse(
          format === "json" ? blocked.stdout : JSON.stringify(Bun.YAML.parse(blocked.stdout)),
        );
        expect(blockedEnvelope.error.diagnostics).toEqual(previewEnvelope.result.diagnostics);
        expect(
          blockedEnvelope.error.diagnostics.map(
            ({ kind, keyPath }: { kind: string; keyPath: readonly (string | number)[] }) => ({
              kind,
              keyPath,
            }),
          ),
        ).toEqual([
          { kind: "dropped", keyPath: ["services", "db", "port"] },
          { kind: "unsupported", keyPath: ["services", "db", "environment", "PGPORT"] },
          { kind: "dropped", keyPath: ["services", "db", "moreHttpPorts"] },
        ]);
        expect(JSON.stringify(blockedEnvelope.error.diagnostics)).not.toContain("SECRET123");
        expect(JSON.stringify(blockedEnvelope.error.diagnostics)).toContain("[redacted]");
        expect(await Bun.file(join(dir, ".lando.yml")).text()).toBe(original);
      });
    },
  );
  test("rejects a bare --from with no value instead of silently autodetecting", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: demo\nruntime: 4\n");
      const result = await runCli(["app:config:translate", "--from"], dir);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--from has a malformed value.");
      expect(result.stderr).toContain("code: MalformedCliFlagValueError");
    });
  });

  test("rejects a bare --file with no value instead of silently running full-tree discovery", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: demo\nruntime: 4\n");
      const result = await runCli(["app:config:translate", "--file"], dir);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--file has a malformed value.");
      expect(result.stderr).toContain("code: MalformedCliFlagValueError");
    });
  });

  test("still accepts a valid --list --format=json invocation", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["app:config:translate", "--list", "--format=json"], dir);

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout) as { readonly ok?: boolean };
      expect(envelope.ok).toBe(true);
    });
  });

  test("accepts --to with a value", async () => {
    await withTempCwd(async (dir) => {
      const result = await runCli(["app:config:translate", "--to", "lando4", "--list", "--format=json"], dir);

      expect(result.exitCode).toBe(0);
      const envelope = JSON.parse(result.stdout) as { readonly ok?: boolean };
      expect(envelope.ok).toBe(true);
    });
  });

  test("rejects a bare --to with no value", async () => {
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), "name: demo\nruntime: 4\n");
      const result = await runCli(["app:config:translate", "--to"], dir);

      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain("--to has a malformed value.");
      expect(result.stderr).toContain("code: MalformedCliFlagValueError");
    });
  });
});
