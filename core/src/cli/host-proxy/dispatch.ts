import { Cause, Effect, Exit, Schema } from "effect";

import type { HostProxyRunLandoExecutorInput } from "@lando/engine/subsystems/host-proxy/dispatch";
import { RedactionService } from "@lando/redaction/service";
import type { AppPlan, CommandResultEnvelope } from "@lando/sdk/schema";
import { CommandResultEnvelope as CommandResultEnvelopeSchema } from "@lando/sdk/schema";
import type { EventService, RouterService, RuntimeProviderRegistry, ShellRunner } from "@lando/sdk/services";

import {
  buildCommandResultEnvelope,
  failureOutcomeFromCause,
  normalizeDefect,
} from "@lando/sdk/command-result";
import { OpenAppResultSchema, openForPlan } from "../commands/open";
import { collectOpenConnections } from "../commands/open-connections";
import { parseOpenOptionsFromRunLandoArgv } from "./open-argv";

const redactCommandEnvelope = (
  envelope: CommandResultEnvelope,
  redactor: { readonly redactValue: (value: unknown) => unknown },
): CommandResultEnvelope =>
  Schema.decodeUnknownSync(CommandResultEnvelopeSchema)(redactor.redactValue(envelope));

export const runOpenForHostProxy = Effect.fn("HostProxy.runOpen")(function* (
  plan: AppPlan,
  input: HostProxyRunLandoExecutorInput,
): Effect.fn.Return<
  { readonly envelope: CommandResultEnvelope; readonly exitCode: number },
  never,
  ShellRunner | EventService | RedactionService | RouterService | RuntimeProviderRegistry
> {
  const redaction = yield* RedactionService;
  const redactor = yield* redaction.forProfile("secrets", { sourceEnv: process.env });
  const parsed = parseOpenOptionsFromRunLandoArgv(input.argv, { tty: process.stdout.isTTY === true });
  const encoded =
    parsed._tag === "failure"
      ? { outcome: parsed, exitCode: parsed.error.exitCode ?? 2 }
      : yield* Effect.gen(function* () {
          const outcome = yield* Effect.exit(
            Effect.gen(function* () {
              const connections = yield* collectOpenConnections(plan, parsed.options);
              return yield* openForPlan(plan, parsed.options, connections);
            }),
          );
          if (Exit.isSuccess(outcome)) {
            return { outcome: { _tag: "success" as const, value: outcome.value }, exitCode: 0 };
          }
          return {
            outcome: outcome.cause.reasons.every(Cause.isInterruptReason)
              ? {
                  _tag: "failure" as const,
                  additionalErrors: [],
                  error: {
                    _tag: "HostProxyDispatchError",
                    message: Cause.pretty(outcome.cause),
                  },
                }
              : failureOutcomeFromCause(outcome.cause, normalizeDefect),
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
