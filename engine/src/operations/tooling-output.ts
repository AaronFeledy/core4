import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import type { ToolingEngineResult } from "@lando/sdk/services";
import { Effect, Option } from "effect";
import type { StreamFrameSinkShape } from "./stream-frame-sink.ts";

export const toolingOutputRedactor = Effect.fnUntraced(function* (redactionTokens: ReadonlyArray<string>) {
  const redaction = yield* Effect.serviceOption(RedactionService);
  return Option.isSome(redaction)
    ? yield* redaction.value.forProfile("secrets", { sourceEnv: process.env, redactionTokens })
    : createStandaloneRedactor("secrets", { sourceEnv: process.env, redactionTokens });
});

export const emitBufferedToolingOutput = (
  sink: StreamFrameSinkShape,
  redactionTokens: ReadonlyArray<string>,
) =>
  Effect.fnUntraced(function* (result: ToolingEngineResult) {
    const redactor = yield* toolingOutputRedactor(redactionTokens);
    for (const channel of ["stdout", "stderr"] as const) {
      if (result[channel].length > 0) {
        yield* sink.emit({ _tag: channel, chunk: redactor.redactString(result[channel]), raw: true });
      }
    }
  });
