import { expect, test } from "bun:test";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { decodeAppCommandIndex, encodeAppCommandIndex } from "@lando/engine/cache/command-index";
import { writeAppCommandCacheStrict } from "@lando/engine/cache/command-index-writer";
import { appCommandCachePath, appToolingCompilationCachePath } from "@lando/engine/cache/paths";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { ensureCompiledCli } from "../_support/compiled-cli";

const sourceCli = resolve(import.meta.dirname, "../../bin/lando.ts");

for (const execution of ["source", "compiled"] as const)
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    test.skipIf(process.platform !== "linux" || process.arch !== "x64")(
      `${execution} host script ${signal} emits typed cancellation without finishing the script`,
      async () => {
        const compiled = execution === "compiled" ? await ensureCompiledCli() : undefined;
        const root = await mkdtemp(join(tmpdir(), "lando-script-cancellation-"));
        try {
          const cacheRoot = join(root, "cache");
          const bin = join(root, "bin");
          await mkdir(bin);
          const binary = join(bin, "lando");
          if (compiled !== undefined) await copyFile(compiled, binary);
          const launch = compiled === undefined ? [process.execPath, sourceCli] : [binary];
          await mkdir(join(root, ".lando/scripts"), { recursive: true });
          await writeFile(join(root, ".lando.yml"), "name: cancellation\n");
          await writeFile(
            join(root, ".lando/scripts/slow.bun.sh"),
            "# ---\n# desc: Cancellation probe\n# ---\necho ready > ready\nbun -e 'setTimeout(() => {}, 30000)'\necho finished > finished\n",
          );
          await Effect.runPromise(
            writeAppCommandCacheStrict({
              landofile: { name: "cancellation" },
              entries: [
                { id: "app:slow", summary: "Cancellation probe", hidden: false, source: "bun-script" },
              ],
              cwd: root,
              cacheRoot,
            }),
          );
          const env = {
            ...process.env,
            ...(compiled === undefined ? {} : { PATH: bin }),
            LANDO_USER_CACHE_ROOT: cacheRoot,
            LANDO_USER_DATA_ROOT: join(root, "data"),
            LANDO_USER_CONF_ROOT: join(root, "conf"),
          };
          const versionChild = Bun.spawn([...launch, "--version"], {
            cwd: root,
            env,
            stdout: "pipe",
            stderr: "pipe",
          });
          const version = (await new Response(versionChild.stdout).text()).trim();
          expect(await versionChild.exited).toBe(0);
          for (const path of [
            appCommandCachePath(cacheRoot, "cancellation", root),
            appToolingCompilationCachePath(cacheRoot, root),
          ]) {
            const payload = decodeAppCommandIndex(new Uint8Array(await readFile(path)));
            if (payload === null) throw new TypeError(`Invalid command cache: ${path}`);
            await writeFile(path, encodeAppCommandIndex({ ...payload, landoVersion: version }));
          }
          const child = Bun.spawn([...launch, "slow", "--format=json"], {
            cwd: root,
            env,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
          });
          const output = Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
          const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
          try {
            const ready = Bun.file(join(root, "ready"));
            while (!(await ready.exists()) && child.exitCode === null && child.signalCode === null)
              await Bun.sleep(10);
            const started = await ready.exists();
            expect(started, started ? "" : (await output).join("\n")).toBe(true);
            child.kill(signal);
            const code = await child.exited;
            const [stdout, stderr] = await output;
            expect(code, stderr).toBe(signal === "SIGINT" ? 130 : 143);
            expect(child.signalCode).toBe(signal);
            expect(Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(stdout))).toMatchObject({
              command: "app:slow",
              ok: false,
              error: {
                _tag: "CommandInterruptedError",
                signal,
                message: "Command interrupted.",
                remediation: "Run the command again when ready.",
              },
            });
            expect(stdout + stderr).not.toMatch(/LandoInternalError|All fibers interrupted/);
            expect(await Bun.file(join(root, "finished")).exists()).toBe(false);
          } finally {
            clearTimeout(deadline);
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
            await child.exited;
            await output;
          }
        } finally {
          await rm(root, { recursive: true, force: true });
        }
      },
      120_000,
    );
