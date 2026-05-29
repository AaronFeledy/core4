#!/usr/bin/env bun
/** Runs generators in catalog order because some outputs feed later steps. */
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
    id: "build-guide-scenarios",
    cmd: [process.execPath, "run", `${SCRIPT_DIR}/build-guide-scenarios.ts`],
    cwd: REPO_ROOT,
  },
  {
    id: "bundled-plugins",
    cmd: [process.execPath, "run", `${SCRIPT_DIR}/build-bundled-plugins.ts`],
    cwd: REPO_ROOT,
  },
  {
    id: "bundled-recipes",
    cmd: [process.execPath, "run", `${SCRIPT_DIR}/build-bundled-recipes.ts`],
    cwd: REPO_ROOT,
  },
  {
    id: "schema-snapshot",
    cmd: [process.execPath, "run", `${SCRIPT_DIR}/build-schema-snapshot.ts`],
    cwd: REPO_ROOT,
  },
  {
    id: "oclif-manifest",
    cmd: [process.execPath, "run", `${SCRIPT_DIR}/build-oclif-manifest.ts`],
    cwd: CORE_ROOT,
  },
  {
    id: "ci-workflow",
    cmd: [process.execPath, "run", `${SCRIPT_DIR}/build-ci-workflow.ts`],
    cwd: REPO_ROOT,
  },
  {
    id: "release-workflow",
    cmd: [process.execPath, "run", `${SCRIPT_DIR}/build-release-workflow.ts`],
    cwd: REPO_ROOT,
  },
  {
    id: "nightly-workflow",
    cmd: [process.execPath, "run", `${SCRIPT_DIR}/build-nightly-workflow.ts`],
    cwd: REPO_ROOT,
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
