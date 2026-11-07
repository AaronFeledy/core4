import { commandCompletionFromExitCode } from "@lando/sdk/command-result";
import { Effect } from "effect";
import { Args } from "../../spec/metadata";

import { CommandInputValidationError } from "@lando/sdk/errors";

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
  summary: "Run a package with the embedded Bun executable (bunx-equivalent).",
  description: "Run a package with the embedded Bun executable (bunx-equivalent).",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  strict: false,
  usage: "<PACKAGE> [-- <ARGS...>]",
  args: {
    spec: Args.string({ description: "Package spec (e.g. prettier@latest, @astrojs/cli)", required: true }),
  },
  run: Effect.fn("XCommand.run")(function* (input: unknown) {
    const argv = extractSpecParsedArgv(input);
    const { spec, args } = splitSpecAndArgs(argv);
    if (spec === undefined) {
      return yield* Effect.fail(
        new CommandInputValidationError({
          message: "meta:x requires a package spec as the first positional argument.",
          target: "meta:x",
          field: "spec",
          kind: "arg",
          reason: "required",
          remediation: "Example: lando x prettier",
        }),
      );
    }
    return yield* metaX({ spec, argv: args });
  }),
  completion: (result) => commandCompletionFromExitCode(result.exitCode),
  render: (result) => renderMetaXResult(result),
};
