import { Effect } from "effect";
import { Args } from "../../spec/metadata";

import { NotImplementedError } from "@lando/sdk/errors";

import { type MetaXResult, MetaXResultSchema, metaX, renderMetaXResult } from "../../commands/bun";

import type { LandoCommandSpec } from "../../spec/command-base";
import { extractSpecParsedArgv } from "../../spec/command-boundary";

const splitSpecAndArgs = (
  argv: ReadonlyArray<string>,
): { readonly spec: string | undefined; readonly args: ReadonlyArray<string> } => {
  if (argv.length === 0) return { spec: undefined, args: [] };
  const [first, ...rest] = argv;
  return { spec: first, args: rest };
};

export const metaXSpec: LandoCommandSpec<MetaXResult> = {
  resultSchema: MetaXResultSchema,
  id: "meta:x",
  summary: "One-shot package execution via BunSelfRunner.x (bunx-equivalent).",
  description: "One-shot package execution via BunSelfRunner.x (bunx-equivalent).",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  strict: false,
  usage: "<PACKAGE> [-- <ARGS...>]",
  args: {
    spec: Args.string({ description: "Package spec (e.g. prettier@latest, @astrojs/cli)", required: true }),
  },
  run: (input) =>
    Effect.gen(function* () {
      const argv = extractSpecParsedArgv(input);
      const { spec, args } = splitSpecAndArgs(argv);
      if (spec === undefined) {
        return yield* Effect.fail(
          new NotImplementedError({
            message: "meta:x requires a package spec as the first positional argument.",
            commandId: "meta:x",
            remediation: "Example: lando x prettier",
          }),
        );
      }
      return yield* metaX({ spec, argv: args });
    }),
  successExitCode: (result) => result.exitCode,
  render: (result) => renderMetaXResult(result as MetaXResult),
};
