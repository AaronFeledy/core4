import { commandCompletionFromExitCode } from "@lando/sdk/command-result";
import { StreamFrame } from "@lando/sdk/schema";
import {
  type ScratchRunError,
  type ScratchRunResult,
  ScratchRunResultSchema,
  type ScratchRunServices,
  scratchRun,
  scratchRunOptionsFromInput,
  scratchRunRedactionTokens,
} from "../../../commands/scratch-run";
import { attachExecHostIo, toolingHostStdin } from "../../../exec-host-io";
import { isMachineResultFormat } from "../../../format-flags";
import type { LandoCommandSpec } from "../../../spec/command-base";
import { commandResultFormat } from "../../../spec/input-coercion";
import { Args, Flags } from "../../../spec/metadata";
import { execInputUsesCliHostIo } from "../../app/exec";

export const appsScratchRunSpec: LandoCommandSpec<ScratchRunResult, ScratchRunError, ScratchRunServices> = {
  resultSchema: ScratchRunResultSchema,
  id: "apps:scratch:run",
  summary: "Run a one-off command in a disposable scratch app.",
  namespace: "apps",
  topLevelAlias: ["scratch:run", "run"],
  aliases: ["scratch:run", "run"],
  bootstrap: "scratch",
  strict: false,
  args: {
    command: Args.string({ multiple: true, description: "Command argv after `--`." }),
  },
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
  streamingMode: "live",
  run: (input) => {
    const options = scratchRunOptionsFromInput(input);
    const nonInteractive =
      typeof input === "object" &&
      input !== null &&
      "interaction" in input &&
      input.interaction === "non-interactive";
    if (!execInputUsesCliHostIo(input) || nonInteractive) return scratchRun(options);
    const machineFormat = isMachineResultFormat(commandResultFormat(input));
    const rendererMode =
      typeof input === "object" && input !== null && "rendererMode" in input ? input.rendererMode : undefined;
    const mode = toolingHostStdin(!machineFormat && rendererMode !== "json");
    const hostIo =
      mode === "none"
        ? {}
        : attachExecHostIo({
            command: options.command,
            tty: mode === "keyboard",
            interactive: mode === "keyboard",
          });
    return scratchRun({ ...options, ...hostIo, hostIo: "cli", machineFormat });
  },
  redactionTokens: (value) => scratchRunRedactionTokens(value),
  completion: (result) => commandCompletionFromExitCode(result.exitCode),
};
