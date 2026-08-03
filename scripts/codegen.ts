#!/usr/bin/env bun
/** Runs generators in catalog order because some outputs feed later steps. */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { CODEGEN_CATALOG, type CodegenCommand, resolveCodegenCommand } from "./codegen-catalog.ts";

const REPOSITORY_ROOT = resolve(import.meta.dirname, "..");
const BOOTSTRAP_MODULES = [
  {
    content: "export const BUILT_IN_COMMAND_IDS: ReadonlyArray<string> = [];\n",
    path: "core/src/cli/generated/command-ids.ts",
  },
  {
    content: "export const MCP_DEFAULT_ALLOWLIST: ReadonlyArray<string> = [];\n",
    path: "core/src/cli/oclif/generated/mcp-allowlist.ts",
  },
  {
    content: "export const HOST_PROXY_RUNLANDO_ALLOWLIST: ReadonlyArray<string> = [];\n",
    path: "core/src/cli/oclif/generated/host-proxy-allowlist.ts",
  },
  {
    content: 'export const COMPILED_OCLIF_MANIFEST = { commands: {}, version: "0.0.0" };\n',
    path: "core/src/cli/oclif/compiled-manifest.ts",
  },
] as const;

export const ensureCodegenBootstrapModules = async (repositoryRoot = REPOSITORY_ROOT): Promise<void> => {
  await Promise.all(
    BOOTSTRAP_MODULES.map(async (module) => {
      const output = resolve(repositoryRoot, module.path);
      if (await Bun.file(output).exists()) return;
      await mkdir(dirname(output), { recursive: true });
      await Bun.write(output, module.content);
    }),
  );
};

const run = async (command: CodegenCommand): Promise<void> => {
  const proc = Bun.spawn({
    cmd: [...command.cmd],
    cwd: command.cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}: ${command.cmd.join(" ")}`);
  }
};

const main = async (): Promise<void> => {
  await ensureCodegenBootstrapModules();
  for (const entry of CODEGEN_CATALOG) {
    console.log(`[codegen] run ${entry.id}`);
    await run(resolveCodegenCommand(entry));
  }
};

if (import.meta.main) await main();
