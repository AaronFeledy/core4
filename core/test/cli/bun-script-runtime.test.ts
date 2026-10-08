import { beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeAppCommandIndex, encodeAppCommandIndex } from "@lando/engine/cache/command-index";
import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { appCommandCachePath, appToolingCompilationCachePath } from "@lando/engine/cache/paths";
import { Effect } from "effect";
import { ensureCompiledCli } from "../_support/compiled-cli.ts";

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")("compiled Bun script runtime", () => {
  let compiledCli = "";
  beforeAll(async () => {
    compiledCli = await ensureCompiledCli();
  }, 120_000);

  test.each([
    ["text", 0],
    ["json", 0],
    ["yaml", 0],
    ["text", 7],
    ["json", 7],
    ["yaml", 7],
  ] as const)(
    "runs native scripts without host Bun in %s mode with exit %i",
    async (format, scriptExitCode) => {
      // Given: only the relocated compiled CLI is available on PATH.
      const root = await mkdtemp(join(tmpdir(), "lando-compiled-script-"));
      const bin = join(root, "bin");
      const cacheRoot = join(root, "cache");
      try {
        await mkdir(bin);
        const binary = join(bin, "lando");
        await copyFile(compiledCli, binary);
        await mkdir(join(root, ".lando/scripts"), { recursive: true });
        await writeFile(join(root, ".lando.yml"), "name: compiled-script\n");
        await writeFile(
          join(root, ".lando/scripts/probe.bun.sh"),
          '# ---\n# desc: Runtime probe\n# ---\necho "<$1>"; echo "<$2>"; echo "<$3>"; echo "<$4>"; echo "$SCRIPT_RUNTIME_VALUE"; pwd; echo diagnostic 1>&2; echo -n tail; exit "$5"\n',
        );
        await Effect.runPromise(
          writeAppCommandCacheStrict({
            landofile: { name: "compiled-script" },
            entries: [{ id: "app:probe", summary: "Runtime probe", hidden: false, source: "bun-script" }],
            cwd: root,
            cacheRoot,
          }),
        );
        const versionProcess = Bun.spawn([binary, "--version"], { stdout: "pipe", stderr: "pipe" });
        const version = (await new Response(versionProcess.stdout).text()).trim();
        expect(await versionProcess.exited).toBe(0);
        for (const path of [
          appCommandCachePath(cacheRoot, "compiled-script", root),
          appToolingCompilationCachePath(cacheRoot, root),
        ]) {
          const payload = decodeAppCommandIndex(new Uint8Array(await readFile(path)));
          if (payload === null) throw new TypeError(`Invalid command cache: ${path}`);
          await writeFile(path, encodeAppCommandIndex({ ...payload, landoVersion: version }));
        }
        // When
        const child = Bun.spawn(
          [
            binary,
            "probe",
            "two words",
            "",
            "$(echo injected)",
            "*.ts",
            String(scriptExitCode),
            `--format=${format}`,
          ],
          {
            cwd: root,
            env: {
              ...process.env,
              PATH: bin,
              SCRIPT_RUNTIME_VALUE: "explicit-env",
              LANDO_USER_CACHE_ROOT: cacheRoot,
              LANDO_USER_DATA_ROOT: join(root, "data"),
              LANDO_USER_CONF_ROOT: join(root, "conf"),
            },
            stdout: "pipe",
            stderr: "pipe",
          },
        );
        const [exitCode, stdout, stderr] = await Promise.all([
          child.exited,
          new Response(child.stdout).text(),
          new Response(child.stderr).text(),
        ]);
        // Then
        expect(exitCode, stderr || stdout).toBe(scriptExitCode);
        const scriptStdout = `<two words>\n<>\n<$(echo injected)>\n<*.ts>\nexplicit-env\n${root}\ntail`;
        if (format === "text") {
          expect(stdout).toContain("<two words>");
          expect(stdout).toContain("<>");
          expect(stdout).toContain("<$(echo injected)>");
          expect(stdout).toContain("<*.ts>");
          expect(stdout).toContain("explicit-env");
          expect(stdout).toContain(root);
          expect(stdout).toContain("tail");
          expect(stdout + stderr).toContain("diagnostic");
        } else {
          const envelope = format === "json" ? JSON.parse(stdout) : Bun.YAML.parse(stdout);
          expect(envelope).toMatchObject({
            ok: true,
            result: { exitCode: scriptExitCode, stdout: scriptStdout, stderr: "diagnostic\n" },
          });
        }
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
    60_000,
  );
});
