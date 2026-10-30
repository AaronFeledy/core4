import { CORE_VERSION } from "@lando/engine/version";
import {
  type CommandResultEnvelopeFormat,
  encodeCommandResult,
  identityRedactor,
} from "@lando/sdk/command-result";
import { ToolingInputDeclaration } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { emitResultLine } from "./compiled-runtime";

export const HelpTargetResult = Schema.Struct({
  version: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  target: Schema.Struct({
    canonicalId: Schema.String,
    typeable: Schema.String,
    extras: Schema.Array(Schema.String),
    summary: Schema.String,
    source: Schema.Literals(["built-in", "tooling"]),
    input: Schema.optionalKey(ToolingInputDeclaration),
  }),
});

type HelpTarget = typeof HelpTargetResult.Type.target;

export const printMachineHelpTarget = (
  target: HelpTarget,
  format: CommandResultEnvelopeFormat,
): Promise<void> =>
  emitResultLine(
    Effect.runSync(
      encodeCommandResult({
        command: "cli:help",
        resultSchema: HelpTargetResult,
        outcome: {
          _tag: "success",
          value: { version: CORE_VERSION, platform: process.platform, arch: process.arch, target },
        },
        redactor: identityRedactor,
        format,
      }),
    ),
  );
