/**
 * `ToolingEngine` Effect service contract.
 *
 * Default: `providerExec`. Plugin alternatives: `host`, `remote`, `dryRun`.
 *
 * Selection precedence: `tooling.<name>.engine` → Landofile-level
 * `toolingEngine` → global config `toolingEngine` → default `providerExec`.
 */
export { ToolingEngine } from "@lando/sdk/services";
