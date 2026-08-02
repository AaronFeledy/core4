#!/usr/bin/env bun
/** Runs generators in catalog order because some outputs feed later steps. */
import { CODEGEN_CATALOG, type CodegenCommand, resolveCodegenCommand } from "./codegen-catalog.ts";

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
  for (const entry of CODEGEN_CATALOG) {
    console.log(`[codegen] run ${entry.id}`);
    await run(resolveCodegenCommand(entry));
  }
};

if (import.meta.main) await main();
