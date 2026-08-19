import { Flags } from "../../../spec/metadata";

import { StreamFrame } from "@lando/sdk/schema";
import {
  type ScratchRunResult,
  ScratchRunResultSchema,
  renderScratchRunResult,
  scratchRun,
  scratchRunOptionsFromInput,
  scratchRunRedactionTokens,
  scratchRunSuccessExitCode,
} from "../../../commands/scratch-run";
import type { RenderContext } from "../../../renderer-boundary";
import type { LandoCommandSpec } from "../../../spec/command-base";

export const appsScratchRunSpec: LandoCommandSpec<ScratchRunResult> = {
  resultSchema: ScratchRunResultSchema,
  id: "apps:scratch:run",
  summary: "Run a one-off command in a disposable scratch app.",
  namespace: "apps",
  topLevelAlias: ["scratch:run", "run"],
  aliases: ["scratch:run", "run"],
  bootstrap: "scratch",
  strict: false,
  flags: {
    from: Flags.string({
      description: "Recipe reference for the disposable scratch app (default: the bundled toolbox).",
    }),
    service: Flags.string({ description: "Service to run the command in (default: the primary service)." }),
    "no-mount": Flags.boolean({
      description: "Do not mount the current working directory into the scratch app.",
      default: false,
    }),
    answer: Flags.string({ description: "Recipe answer in key=value form (repeatable).", multiple: true }),
    keep: Flags.boolean({
      description: "Keep the scratch app after the command exits and print its id.",
      default: false,
    }),
  },
  streaming: StreamFrame,
  run: (input) => scratchRun(scratchRunOptionsFromInput(input)),
  streamFrames: (value) => {
    const result = value as ScratchRunResult;
    const frames = [];
    if (result.stdout.length > 0)
      frames.push({ _tag: "stdout" as const, service: result.service, chunk: result.stdout });
    if (result.stderr.length > 0)
      frames.push({ _tag: "stderr" as const, service: result.service, chunk: result.stderr });
    return frames;
  },
  redactionTokens: (value) => scratchRunRedactionTokens(value as ScratchRunResult),
  render: (result, ctx) => renderScratchRunResult(result as ScratchRunResult, ctx as RenderContext),
  successExitCode: (result) => scratchRunSuccessExitCode(result),
};
