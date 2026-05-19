import { Args } from "@oclif/core";
import { Cause, Effect, Exit } from "effect";

import { type MetaXResult, metaX, renderMetaXResult } from "../../../commands/bun.ts";

import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

const extractArgv = (input: unknown): ReadonlyArray<string> => {
  if (typeof input !== "object" || input === null || !("argv" in input)) return [];
  const argv = (input as { argv: unknown }).argv;
  return Array.isArray(argv) ? (argv.filter((v) => typeof v === "string") as ReadonlyArray<string>) : [];
};

const splitSpecAndArgs = (
  argv: ReadonlyArray<string>,
): { readonly spec: string | undefined; readonly args: ReadonlyArray<string> } => {
  if (argv.length === 0) return { spec: undefined, args: [] };
  const [first, ...rest] = argv;
  return { spec: first, args: rest };
};

export const metaXSpec: LandoCommandSpec<MetaXResult> = {
  id: "meta:x",
  summary: "One-shot package execution via BunSelfRunner.x (bunx-equivalent).",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  run: (input) =>
    Effect.gen(function* () {
      const argv = extractArgv(input);
      const { spec, args } = splitSpecAndArgs(argv);
      if (spec === undefined) {
        return yield* Effect.fail(
          new Error("meta:x requires a package spec as the first positional argument."),
        );
      }
      const result = yield* metaX({ spec, argv: args });
      if (result.exitCode !== 0) process.exitCode = result.exitCode;
      return result;
    }),
  render: (result) => renderMetaXResult(result as MetaXResult),
};

export default class MetaXCommand extends LandoCommandBase {
  static override description = metaXSpec.summary;
  static override aliases = [...resolveTopLevelAliases(metaXSpec)];
  static override strict = false;
  static override args = {
    spec: Args.string({ description: "Package spec (e.g. prettier@latest, @astrojs/cli)", required: true }),
  };
  static override landoSpec: LandoCommandSpec = metaXSpec;
  static override bootstrap = metaXSpec.bootstrap;

  override async run(): Promise<void> {
    const argv = this.argv.slice();
    const { spec, args } = splitSpecAndArgs(argv);
    if (spec === undefined) {
      throw new Error("meta:x requires a package spec as the first positional argument.");
    }
    const exit = await Effect.runPromiseExit(metaX({ spec, argv: args }));
    if (Exit.isSuccess(exit)) {
      if (exit.value.exitCode !== 0) process.exitCode = exit.value.exitCode;
      const rendered = renderMetaXResult(exit.value);
      if (rendered !== undefined && rendered.length > 0) this.log(rendered);
      return;
    }
    const failure = Cause.failureOption(exit.cause);
    if (failure._tag === "Some") throw failure.value as Error;
    throw new Error(Cause.pretty(exit.cause));
  }
}
