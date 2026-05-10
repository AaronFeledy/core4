#!/usr/bin/env bun
/**
 * Codegen orchestrator — Stage 1 of the build pipeline (SPEC: §17.1).
 *
 * Runs every generator in the §17.2 catalog. Order matters because some
 * outputs feed others (e.g. the bundled-plugins index informs the bootstrap
 * layers; the OCLIF manifest reads the static command tree).
 *
 * Each generator below is gated by a `bun run build:check` drift check:
 * after running, `git diff --exit-code` MUST be clean.
 */
import { $ } from "bun";

const SCRIPT_DIR = import.meta.dirname;

const generators = [
  { id: "bundled-plugins", path: `${SCRIPT_DIR}/build-bundled-plugins.ts`, status: "ready" },
  { id: "bundled-recipes", path: `${SCRIPT_DIR}/build-bundled-recipes.ts`, status: "stub" },
  { id: "bundled-plugin-templates", path: `${SCRIPT_DIR}/build-bundled-plugin-templates.ts`, status: "stub" },
  { id: "bootstrap-layers", path: `${SCRIPT_DIR}/build-bootstrap-layers.ts`, status: "stub" },
  { id: "oclif-manifest", path: `${SCRIPT_DIR}/build-oclif-manifest.ts`, status: "stub" },
  { id: "schema-json", path: `${SCRIPT_DIR}/build-schema-json.ts`, status: "stub" },
] as const;

const main = async (): Promise<void> => {
  for (const gen of generators) {
    if (gen.status === "stub") {
      console.log(`[codegen] skip ${gen.id} (stub — script not yet implemented)`);
      continue;
    }
    console.log(`[codegen] run ${gen.id}`);
    await $`bun run ${gen.path}`;
  }
};

await main();
