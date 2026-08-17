import { Cause, Effect, Exit, Option, Schema } from "effect";

import type {
  HostProxyRunLandoExecutorInput,
  HostProxyRunLandoResult,
} from "@lando/engine/subsystems/host-proxy/dispatch";
import { RedactionService } from "@lando/redaction/service";
import type { AppPlan, CommandResultEnvelope } from "@lando/sdk/schema";
import { CommandResultEnvelope as CommandResultEnvelopeSchema } from "@lando/sdk/schema";
import type { EventService, ShellRunner } from "@lando/sdk/services";

import { buildCommandResultEnvelope } from "@lando/sdk/command-result";
import { OpenAppResultSchema, openForPlan } from "../commands/open";
import { parseOpenOptionsFromRunLandoArgv } from "./open-argv";

const redactCommandEnvelope = (
  envelope: CommandResultEnvelope,
  redactor: { readonly redactValue: (value: unknown) => unknown },
): CommandResultEnvelope =>
  Schema.decodeUnknownSync(CommandResultEnvelopeSchema)(redactor.redactValue(envelope));

export const runOpenForHostProxy = (
  plan: AppPlan,
  input: HostProxyRunLandoExecutorInput,
): Effect.Effect<HostProxyRunLandoResult, never, ShellRunner | EventService | RedactionService> =>
  Effect.gen(function* () {
    const redaction = yield* RedactionService;
    const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
    const parsed = parseOpenOptionsFromRunLandoArgv(input.argv, { tty: process.stdout.isTTY === true });
    const encoded =
      parsed._tag === "failure"
        ? { outcome: { _tag: "failure" as const, error: parsed.error }, exitCode: parsed.error.exitCode ?? 2 }
        : yield* Effect.gen(function* () {
            const outcome = yield* Effect.exit(openForPlan(plan, parsed.options));
            if (Exit.isSuccess(outcome)) {
              return { outcome: { _tag: "success" as const, value: outcome.value }, exitCode: 0 };
            }
            return {
              outcome: {
                _tag: "failure" as const,
                error: Option.getOrElse(Cause.failureOption(outcome.cause), () => ({
                  _tag: "HostProxyDispatchError",
                  message: Cause.pretty(outcome.cause),
                })),
              },
              exitCode: 1,
            };
          });
    const envelope = yield* buildCommandResultEnvelope({
      command: "app:open",
      resultSchema: OpenAppResultSchema,
      outcome: encoded.outcome,
      redactor,
    });
    return { envelope: redactCommandEnvelope(envelope, redactor), exitCode: encoded.exitCode };
  });
