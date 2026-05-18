import { Effect } from "effect";

import { type MetaBunResult, metaBun, renderMetaBunResult } from "../../../commands/bun.ts";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

const extractArgv = (input: unknown): ReadonlyArray<string> => {
  if (typeof input !== "object" || input === null || !("argv" in input)) return [];
  const argv = (input as { argv: unknown }).argv;
  return Array.isArray(argv) ? (argv.filter((v) => typeof v === "string") as ReadonlyArray<string>) : [];
};

export const metaBunSpec: LandoCommandSpec<MetaBunResult> = {
  id: "meta:bun",
  summary: "Proxy to the embedded Bun CLI via BunSelfRunner.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: (input) =>
    Effect.gen(function* () {
      const argv = extractArgv(input);
      const result = yield* metaBun({ argv });
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
      return result;
    }),
  render: (result) => renderMetaBunResult(result as MetaBunResult),
};

export default class MetaBunCommand extends LandoCommandBase {
  static override description = metaBunSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaBunSpec)];
  static override strict = false;
  static override landoSpec: LandoCommandSpec = metaBunSpec;
  static override bootstrap = metaBunSpec.bootstrap;

  override async run(): Promise<void> {
    await this.runEffect(metaBunSpec);
  }
}
