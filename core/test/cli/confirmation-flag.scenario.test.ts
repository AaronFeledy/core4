import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CommandResultEnvelope } from "@lando/sdk/schema";
import { Schema } from "effect";

import { ensureCompiledCli } from "../_support/compiled-cli.ts";

const sourceCli = resolve(import.meta.dirname, "../../bin/lando.ts");
const cases = [
  {
    argv: ["scratch:destroy", "missing-scratch", "--yes"],
    command: "apps:scratch:destroy",
    tag: "ScratchAppNotFoundError",
  },
  {
    argv: ["scratch:destroy", "missing-scratch", "-y"],
    command: "apps:scratch:destroy",
    tag: "ScratchAppNotFoundError",
  },
  {
    argv: ["db:restore", "snap", "-y"],
    command: "db:restore",
    tag: "SqlServiceNotFoundError",
  },
] as const;

for (const mode of ["source", "relocated compiled"] as const) {
  describe.skipIf(mode === "relocated compiled" && (process.platform !== "linux" || process.arch !== "x64"))(
    `confirmation flags (${mode} CLI)`,
    () => {
      let prefix = [process.execPath, sourceCli];
      let binaryRoot: string | undefined;

      beforeAll(async () => {
        if (mode === "source") return;
        const binary = await ensureCompiledCli();
        binaryRoot = await mkdtemp(join(tmpdir(), "lando-confirmation-binary-"));
        const relocated = join(binaryRoot, "lando relocated");
        await copyFile(binary, relocated);
        prefix = [relocated];
      }, 120_000);

      afterAll(async () => {
        if (binaryRoot !== undefined) await rm(binaryRoot, { recursive: true, force: true });
      });

      for (const { argv, command, tag } of cases) {
        test(`${argv.join(" ")} reaches its normal domain failure`, async () => {
          // Given
          const root = await mkdtemp(join(tmpdir(), "lando-confirmation-app-"));
          try {
            await Bun.write(join(root, ".lando.yml"), "name: confirmation\nservices: {}\n");
            const env = {
              ...process.env,
              PATH: root,
              BUN_BE_BUN: undefined,
              DOCKER_HOST: undefined,
              CONTAINER_HOST: undefined,
              LANDO_PROVIDER: "podman",
              LANDO_USER_CONF_ROOT: join(root, "config"),
              LANDO_USER_DATA_ROOT: join(root, "data"),
              LANDO_USER_CACHE_ROOT: join(root, "cache"),
            };
            // When
            const proc = Bun.spawn({
              cmd: [...prefix, ...argv, "--format=json"],
              cwd: root,
              env,
              stdout: "pipe",
              stderr: "pipe",
              timeout: 20_000,
            });
            const [exitCode, stdout, stderr] = await Promise.all([
              proc.exited,
              new Response(proc.stdout).text(),
              new Response(proc.stderr).text(),
            ]);
            // Then
            expect(exitCode, stderr).toBe(1);
            const envelope = Schema.decodeUnknownSync(CommandResultEnvelope)(JSON.parse(stdout));
            expect(envelope).toMatchObject({ command, ok: false, error: { _tag: tag } });
          } finally {
            await rm(root, { recursive: true, force: true });
          }
        }, 30_000);
      }
    },
  );
}
