#!/usr/bin/env bun
/**
 * Regenerate `core/src/cli/oclif/generated/mcp-allowlist.ts` from every
 * `LandoCommandSpec` with `mcpAllowed: true`.
 *
 * Inputs:
 *   - `core/src/cli/oclif/compiled-commands.ts` (the canonical command index)
 *
 * Output:
 *   - `core/src/cli/oclif/generated/mcp-allowlist.ts` — plain literal data (no
 *     command/Effect imports) listing the default set of canonical command ids
 *     `lando mcp` exposes as tools. Keeping it a literal-data module means a
 *     consumer never pulls the compiled CLI command graph into scope.
 *
 * Freshness: `core/test/cli/mcp-allowlist.test.ts` re-derives the list and
 * asserts this module matches the live command specs.
 */
import { resolve } from "node:path";

import type { LandoCommandSpec } from "../core/src/cli/oclif/command-base.ts";
import compiledCommands from "../core/src/cli/oclif/compiled-commands.ts";
import { computeMcpDefaultAllowlist } from "../core/src/cli/oclif/mcp-allowlist.ts";
import { writeFormattedOutput } from "./_codegen-output.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(REPO_ROOT, "core/src/cli/oclif/generated/mcp-allowlist.ts");

const HEADER = `/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via \`bun run scripts/build-mcp-allowlist.ts\`.
 *
 * Source of truth: every \`LandoCommandSpec\` with \`mcpAllowed: true\`.
 *
 * This is deliberately a literal-data module with no command or Effect imports,
 * so a consumer can read the default MCP allowlist without pulling the compiled
 * CLI command graph into scope (a cold-start regression).
 */`;

const renderModule = (ids: ReadonlyArray<string>): string => {
  const body = ids.map((id) => `  ${JSON.stringify(id)},`).join("\n");
  return [HEADER, "", `export const MCP_DEFAULT_ALLOWLIST: ReadonlyArray<string> = [\n${body}\n];`, ""].join(
    "\n",
  );
};

const main = async (): Promise<void> => {
  const specs = Object.values(compiledCommands)
    .map((commandClass) => (commandClass as { readonly landoSpec?: LandoCommandSpec }).landoSpec)
    .filter((spec): spec is LandoCommandSpec => spec !== undefined);
  const ids = computeMcpDefaultAllowlist(specs);
  await writeFormattedOutput(OUTPUT, renderModule(ids));
  console.log(`[build-mcp-allowlist] wrote ${OUTPUT} (${ids.length} tools)`);
};

if (import.meta.main) await main();
