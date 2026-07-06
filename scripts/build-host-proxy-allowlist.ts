#!/usr/bin/env bun
/**
 * Regenerate `core/src/cli/oclif/generated/host-proxy-allowlist.ts` from every
 * `LandoCommandSpec` with `hostProxyAllowed: true`.
 *
 * Inputs:
 *   - `core/src/cli/oclif/compiled-commands.ts` (the canonical command index)
 *
 * Output:
 *   - `core/src/cli/oclif/generated/host-proxy-allowlist.ts` — plain literal
 *     data (no command/Effect imports) listing the canonical command ids the
 *     host-proxy `runLando` dispatcher will accept. Keeping it a literal-data
 *     module means a consumer never pulls the compiled CLI command graph into
 *     scope (a cold-start regression).
 *
 * Freshness: `core/test/cli/host-proxy-allowlist.test.ts` re-derives the list
 * and asserts this module matches the live command specs.
 */
import { resolve } from "node:path";

import type { LandoCommandSpec } from "../core/src/cli/oclif/command-base.ts";
import compiledCommands from "../core/src/cli/oclif/compiled-commands.ts";
import { computeHostProxyRunLandoAllowlist } from "../core/src/cli/oclif/host-proxy-allowlist.ts";
import { writeFormattedOutput } from "./_codegen-output.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const OUTPUT = resolve(REPO_ROOT, "core/src/cli/oclif/generated/host-proxy-allowlist.ts");

const HEADER = `/**
 * **GENERATED FILE** — do not edit by hand.
 *
 * Regenerate via \`bun run scripts/build-host-proxy-allowlist.ts\`.
 *
 * Source of truth: every \`LandoCommandSpec\` with \`hostProxyAllowed: true\`.
 *
 * This is deliberately a literal-data module with no command or Effect imports,
 * so the host-proxy dispatcher can read the runLando allowlist without pulling
 * the compiled CLI command graph into scope (a cold-start regression).
 */`;

const renderModule = (ids: ReadonlyArray<string>): string => {
  const body = ids.map((id) => `  ${JSON.stringify(id)},`).join("\n");
  return [
    HEADER,
    "",
    `export const HOST_PROXY_RUNLANDO_ALLOWLIST: ReadonlyArray<string> = [\n${body}\n];`,
    "",
  ].join("\n");
};

const main = async (): Promise<void> => {
  const specs = Object.values(compiledCommands)
    .map((commandClass) => (commandClass as { readonly landoSpec?: LandoCommandSpec }).landoSpec)
    .filter((spec): spec is LandoCommandSpec => spec !== undefined);
  const ids = computeHostProxyRunLandoAllowlist(specs);
  await writeFormattedOutput(OUTPUT, renderModule(ids));
  console.log(`[build-host-proxy-allowlist] wrote ${OUTPUT} (${ids.length} commands)`);
};

if (import.meta.main) await main();
