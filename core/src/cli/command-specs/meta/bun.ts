import { Effect } from "effect";

import { type MetaBunResult, MetaBunResultSchema, metaBun, renderMetaBunResult } from "../../commands/bun";

import type { LandoCommandSpec } from "../../spec/command-base";

const extractArgv = (input: unknown): ReadonlyArray<string> => {
  if (typeof input !== "object" || input === null || !("argv" in input)) return [];
  const argv = (input as { argv: unknown }).argv;
  return Array.isArray(argv) ? (argv.filter((v) => typeof v === "string") as ReadonlyArray<string>) : [];
};

export const metaBunSpec: LandoCommandSpec<MetaBunResult> = {
  resultSchema: MetaBunResultSchema,
  id: "meta:bun",
  summary: "Proxy to the embedded Bun CLI via BunSelfRunner.",
  description: "Proxy to the embedded Bun CLI via BunSelfRunner.",
  namespace: "meta",
  topLevelAlias: true,
  bootstrap: "minimal",
  strict: false,
  run: (input) =>
    Effect.gen(function* () {
      const argv = extractArgv(input);
      return yield* metaBun({ argv });
    }),
  successExitCode: (result) => result.exitCode,
  render: (result) => renderMetaBunResult(result as MetaBunResult),
};
