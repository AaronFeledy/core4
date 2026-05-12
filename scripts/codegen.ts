#!/usr/bin/env bun
/**
 * Codegen orchestrator — Stage 1 of the build pipeline.
 *
 * Runs every generator in the catalog. Order matters because some
 * outputs feed others (e.g. the bundled-plugins index informs the bootstrap
 * layers; the OCLIF manifest reads the static command tree).
 *
 * Each generator below is gated by a `bun run build:check` drift check:
 * after running, `git diff --exit-code` MUST be clean.
 */
import { resolve } from "node:path";

const SCRIPT_DIR = import.meta.dirname;
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const CORE_ROOT = resolve(REPO_ROOT, "core");

interface Generator {
  readonly id: string;
  readonly cmd: Array<string>;
  readonly cwd: string;
}

const generators: ReadonlyArray<Generator> = [
  {
    id: "bundled-plugins",
    cmd: [process.execPath, "run", `${SCRIPT_DIR}/build-bundled-plugins.ts`],
    cwd: REPO_ROOT,
  },
  {
    id: "oclif-manifest",
    cmd: [process.execPath, "run", `${SCRIPT_DIR}/build-oclif-manifest.ts`],
    cwd: CORE_ROOT,
  },
] satisfies ReadonlyArray<Generator>;

const run = async (cmd: Array<string>, cwd: string): Promise<void> => {
  const proc = Bun.spawn({ cmd, cwd, stdout: "inherit", stderr: "inherit" });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    throw new Error(`Command failed with exit code ${exitCode}: ${cmd.join(" ")}`);
  }
};

const main = async (): Promise<void> => {
  for (const gen of generators) {
    console.log(`[codegen] run ${gen.id}`);
    await run(gen.cmd, gen.cwd);
  }
};

await main();
