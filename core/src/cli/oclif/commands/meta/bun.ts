import { Effect, Layer } from "effect";

import {
  type MetaBunResult,
  MetaBunResultSchema,
  metaBun,
  renderMetaBunResult,
} from "../../../commands/bun.ts";

import { runWithRendererHandling } from "../../../renderer-boundary.ts";
import {
  LandoCommandBase,
  type LandoCommandSpec,
  formatCommandError,
  resolveTopLevelAliases,
} from "../../command-base.ts";

const extractArgv = (input: unknown): ReadonlyArray<string> => {
  if (typeof input !== "object" || input === null || !("argv" in input)) return [];
  const argv = (input as { argv: unknown }).argv;
  return Array.isArray(argv) ? (argv.filter((v) => typeof v === "string") as ReadonlyArray<string>) : [];
};

export const metaBunSpec: LandoCommandSpec<MetaBunResult> = {
  resultSchema: MetaBunResultSchema,
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
  successExitCode: (result) => result.exitCode,
  render: (result) => renderMetaBunResult(result as MetaBunResult),
};

export default class MetaBunCommand extends LandoCommandBase {
  static override description = metaBunSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaBunSpec)];
  static override strict = false;
  static override landoSpec: LandoCommandSpec = metaBunSpec;
  static override bootstrap = metaBunSpec.bootstrap;

  override async run(): Promise<void> {
    const argv = this.argv.slice();
    await runWithRendererHandling(metaBun({ argv }), {
      runtime: Layer.empty,
      rendererMode: "plain",
      command: metaBunSpec.id,
      invocation: {
        commandId: metaBunSpec.id,
        argv,
        args: {},
        flags: {},
        cwd: process.cwd(),
      },
      resultSchema: metaBunSpec.resultSchema,
      render: renderMetaBunResult,
      successExitCode: (result) => result.exitCode,
      formatError: (error) => formatCommandError({ error, commandId: metaBunSpec.id, rendererMode: "plain" }),
    });
  }
}
