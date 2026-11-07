import { RedactionService } from "@lando/redaction/service";
import { Effect } from "effect";
import { CliInvocation, type CliInvocationContext } from "./invocation-context";

export const helpRedactor = Effect.gen(function* () {
  const service = yield* RedactionService;
  return yield* service.forProfile("secrets", { sourceEnv: (yield* CliInvocation).env });
}).pipe(Effect.provide(RedactionService.layer));

export const redactHelpText = (text: string, context?: CliInvocationContext): Promise<string> => {
  const effect = Effect.map(helpRedactor, (redactor) => redactor.redactString(text));
  return Effect.runPromise(
    context === undefined ? effect : effect.pipe(Effect.provideService(CliInvocation, context)),
  );
};
