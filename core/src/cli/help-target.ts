import { CORE_VERSION } from "@lando/engine/version";
import { type CommandResultEnvelopeFormat, encodeCommandResult } from "@lando/sdk/command-result";
import { Effect, Schema } from "effect";
import {
  CliInvocation,
  type CliInvocationContext,
  processInvocationContext,
} from "../runtime/invocation-context";
import { emitResultLine } from "./compiled-runtime";
import { HelpCommandTargetDescriptor } from "./help-command-descriptor";
import { helpRedactor } from "./help-redaction";

export const HelpTargetResult = Schema.Struct({
  version: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  target: HelpCommandTargetDescriptor,
});

type HelpTarget = typeof HelpTargetResult.Type.target;

export const printMachineHelpTarget = (
  target: HelpTarget,
  format: CommandResultEnvelopeFormat,
  context: CliInvocationContext = processInvocationContext(),
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const redactor = yield* helpRedactor;
      const line = yield* encodeCommandResult({
        command: "cli:help",
        resultSchema: HelpTargetResult,
        outcome: {
          _tag: "success",
          value: { version: CORE_VERSION, platform: process.platform, arch: process.arch, target },
        },
        redactor,
        format,
      });
      yield* Effect.promise(() => emitResultLine(line, context));
    }).pipe(Effect.provideService(CliInvocation, context)),
  );
